// SPDX-License-Identifier: GPL-2.0-only
// Linux-side file/process service. The host mailbox is polled without blocking
// a scheduled Linux task in Atomics.wait; usleep/poll let the kernel schedule.
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <sched.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

__attribute__((import_module("env"), import_name("pi_receive")))
extern int pi_receive(void *buffer, int capacity);
__attribute__((import_module("env"), import_name("pi_reply")))
extern void pi_reply(int id, int kind, const void *buffer, int length, int status);
__attribute__((import_module("env"), import_name("pi_cancelled")))
extern int pi_cancelled(int id);

enum { EXEC=1, OPEN, READ, CLOSE, STAT, FSTAT, WRITE, MKDIR, LIST, REMOVE, REALPATH, RENAME, TRUNCATE, FLUSH };
enum { READY=0, STDOUT=1, STDERR=2, DONE=3, ERROR=4, DATA=5 };
static unsigned char packet[1024*1024], bytes[64*1024];
// The upstream loader gives userspace only 8 KiB of stack. Keep the
// 4096-entry request argument table in static storage, like the packet.
static char *args[4097];
extern char **environ;

struct child_options { int *out, *err; char *cwd; char **argv, **environment; };
static int run_child(void *opaque) {
  struct child_options *options=opaque;
  setsid();
  close(options->out[0]); close(options->err[0]);
  dup2(options->out[1],1); dup2(options->err[1],2);
  close(options->out[1]); close(options->err[1]);
  int input=open("/dev/null",O_RDONLY);
  if(input>=0) { dup2(input,0); close(input); }
  if(chdir(options->cwd)<0) { perror("chdir"); _exit(126); }
  execvpe(options->argv[0],options->argv,options->environment);
  perror(options->argv[0]); _exit(127);
}

static long long milliseconds(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void failure(int id) {
  int code = errno;
  const char *message = strerror(code);
  pi_reply(id, ERROR, message, strlen(message), code);
}

static void info(int id, struct stat *st, const char *name) {
  char values[128];
  const char *kind = S_ISDIR(st->st_mode) ? "directory" : S_ISLNK(st->st_mode) ? "symlink" : S_ISREG(st->st_mode) ? "file" : "other";
  pi_reply(id, DATA, name, strlen(name)+1, 0);
  int length = snprintf(values, sizeof(values), "%s%c%lld%c%lld", kind, 0, (long long)st->st_size, 0,
    (long long)st->st_mtim.tv_sec*1000 + st->st_mtim.tv_nsec/1000000);
  pi_reply(id, DATA, values, length+1, 0);
}

static int write_all(int fd, const void *buffer, size_t length) {
  size_t offset=0;
  while(offset<length) {
    ssize_t written=write(fd,(const char *)buffer+offset,length-offset);
    if(written<0 && errno==EINTR)continue;
    if(written<=0) { if(!written)errno=EIO; return -1; }
    offset+=written;
  }
  return 0;
}

static void execute(int id, char **args, int count) {
  // cwd, inheritEnv, envCount, spillBytes, spillLines, env entries..., argv...
  int env_count = atoi(args[2]), inherited = 0;
  if (atoi(args[1])) while (environ[inherited]) inherited++;
  char **environment = calloc(inherited + env_count + 1, sizeof(char *));
  if (!environment) { failure(id); return; }
  int used = 0;
  for (int i=0; i<inherited; i++) {
    int overridden = 0;
    for (int j=0; j<env_count; j++) {
      size_t key = strcspn(args[5+j], "=");
      if (!strncmp(environ[i], args[5+j], key) && environ[i][key]=='=') overridden=1;
    }
    if (!overridden) environment[used++]=environ[i];
  }
  for (int j=0; j<env_count; j++) environment[used++]=args[5+j];
  char **argv = args+5+env_count;
  int out[2], err[2];
  if (pipe(out)<0) { free(environment); failure(id); return; }
  if (pipe(err)<0) { close(out[0]); close(out[1]); free(environment); failure(id); return; }
  char output_path[]="/tmp/pi-output-XXXXXX";
  long spill_bytes=atol(args[3]), spill_lines=atol(args[4]);
  int output_fd = spill_bytes>0 ? mkstemp(output_path) : -1;
  if (spill_bytes>0 && output_fd<0) {
    close(out[0]); close(out[1]); close(err[0]); close(err[1]); free(environment); failure(id); return;
  }
  if (output_fd>=0) fcntl(output_fd, F_SETFD, FD_CLOEXEC);
  struct child_options options={out,err,args[0],argv,environment};
  // The upstream Wasm libc requires callback-based clone; vfork aborts.
  pid_t child=clone(run_child,NULL,CLONE_VM|CLONE_VFORK|SIGCHLD,&options);
  int spawn_errno=errno;
  free(environment);
  close(out[1]); close(err[1]);
  if (child<0) {
    close(out[0]); close(err[0]);
    if(output_fd>=0) { close(output_fd); unlink(output_path); }
    errno=spawn_errno; failure(id); return;
  }
  fcntl(out[0], F_SETFL, O_NONBLOCK); fcntl(err[0], F_SETFL, O_NONBLOCK);
  struct pollfd streams[2]={{out[0], POLLIN, 0}, {err[0], POLLIN, 0}};
  long long cancelled_at=0;
  long total=0, lines=0;
  int status=0, finished=0, write_error=0, last_newline=1;
  while (!finished) {
    if (!cancelled_at && pi_cancelled(id)) { cancelled_at=milliseconds(); kill(-child, SIGTERM); }
    if (cancelled_at && milliseconds()-cancelled_at>=250) kill(-child, SIGKILL);
    poll(streams, 2, 20);
    for (int i=0; i<2; i++) {
      // Bounded draining keeps cancellation responsive for an infinite writer.
      for (int n=0; n<4; n++) {
        ssize_t length=read(streams[i].fd, bytes, sizeof(bytes));
        if (length<=0) break;
        total+=length;
        for (ssize_t j=0; j<length; j++) if(bytes[j]=='\n') lines++;
        last_newline=bytes[length-1]=='\n';
        if (output_fd>=0 && !write_error) {
          if(write_all(output_fd,bytes,length)<0) { write_error=errno; kill(-child,SIGKILL); }
        }
        pi_reply(id, i==0?STDOUT:STDERR, bytes, length, 0);
      }
    }
    pid_t waited=waitpid(child, &status, WNOHANG);
    if(waited==child) {
      // Drain bytes already in the pipes before finishing; don't wait for a
      // background descendant that inherited an output handle to close it.
      finished=1;
      for(int i=0;i<2;i++) {
        int remaining=0;
        if(ioctl(streams[i].fd,FIONREAD,&remaining)<0) { write_error=errno; break; }
        while(remaining>0) {
          ssize_t length=read(streams[i].fd,bytes,remaining<(int)sizeof(bytes)?remaining:sizeof(bytes));
          if(length<=0)break;
          remaining-=length;
          total+=length;
          for(ssize_t j=0;j<length;j++) if(bytes[j]=='\n') lines++;
          last_newline=bytes[length-1]=='\n';
          if(output_fd>=0 && !write_error && write_all(output_fd,bytes,length)<0)write_error=errno;
          pi_reply(id, i==0?STDOUT:STDERR, bytes, length, 0);
        }
      }
    } else if(waited<0 && errno!=EINTR) { write_error=errno; finished=1; }
  }
  if(cancelled_at) kill(-child, SIGKILL);
  close(out[0]); close(err[0]);
  if(output_fd>=0) close(output_fd);
  int spilled=output_fd>=0 && (total>spill_bytes || lines+!last_newline>spill_lines);
  if(output_fd>=0 && !spilled) unlink(output_path);
  if(write_error) { errno=write_error; failure(id); return; }
  int exit_code=WIFEXITED(status)?WEXITSTATUS(status):128+WTERMSIG(status);
  pi_reply(id, DONE, spilled?output_path:"", spilled?strlen(output_path):0, exit_code);
}

int main(int argc, char **argv) {
  pi_reply(0, READY, NULL, 0, 0);
  while(1) {
    int length=pi_receive(packet, sizeof(packet));
    if(length==0) { usleep(10000); continue; }
    if(length<16) continue;
    uint32_t *header=(uint32_t *)packet;
    int id=header[0], operation=header[1], count=header[2], data_length=header[3];
    char *position=(char *)packet+16, *end=(char *)packet+length-data_length;
    if(count<0 || count>4096 || data_length<0 || end<position) { errno=EINVAL; failure(id); continue; }
    int valid=1;
    for(int i=0;i<count;i++) {
      char *zero=memchr(position, 0, end-position);
      if(!zero) { valid=0; break; }
      args[i]=position; position=zero+1;
    }
    args[count]=NULL;
    if(!valid || position!=end) { errno=EINVAL; failure(id); continue; }
    const int counts[]={0,-1,2,3,1,1,1,2,1,1,1,1,2,2,1};
    if(operation<EXEC || operation>FLUSH || (operation!=EXEC && count!=counts[operation])) {
      errno=EINVAL; failure(id); continue;
    }
    struct stat st;
    int result=0;
    switch(operation) {
      case EXEC:
        if(count<6 || atoi(args[2])<0 || 5+atoi(args[2])>=count) { errno=EINVAL; failure(id); }
        else execute(id, args, count);
        continue;
      case OPEN:
        result=open(args[0], O_RDONLY | O_CLOEXEC | (atoi(args[1])?O_NOFOLLOW:0));
        if(result>=0) {
          if(fstat(result, &st)<0) { int code=errno; close(result); errno=code; result=-1; }
          else if(!S_ISREG(st.st_mode)) { close(result); errno=S_ISDIR(st.st_mode)?EISDIR:EINVAL; result=-1; }
        }
        break;
      case READ: {
        size_t size=strtoul(args[2],NULL,10);
        if(size>sizeof(bytes)) { errno=EINVAL; result=-1; break; }
        ssize_t size_read=pread(atoi(args[0]),bytes,size,strtoll(args[1],NULL,10));
        if(size_read<0) failure(id); else pi_reply(id,DONE,bytes,size_read,0);
        continue;
      }
      case CLOSE: result=close(atoi(args[0])); break;
      case STAT: case FSTAT:
        result=operation==STAT?lstat(args[0],&st):fstat(atoi(args[0]),&st);
        if(result==0) info(id,&st,operation==STAT?args[0]:"");
        break;
      case WRITE: {
        int fd=open(args[0],O_WRONLY|O_CREAT|O_CLOEXEC|(atoi(args[1])?O_APPEND:O_TRUNC),0666);
        if(fd<0) { result=-1; break; }
        result=write_all(fd,end,data_length);
        int code=errno;
        if(close(fd)<0 && result==0) result=-1; else errno=code;
        break;
      }
      case MKDIR: result=mkdir(args[0],0777); break;
      case LIST: {
        DIR *directory=opendir(args[0]);
        if(!directory) { result=-1; break; }
        struct dirent *entry;
        errno=0;
        while((entry=readdir(directory))) {
          if(!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
          if(fstatat(dirfd(directory),entry->d_name,&st,AT_SYMLINK_NOFOLLOW)<0) { result=-1; break; }
          info(id,&st,entry->d_name);
          errno=0;
        }
        int code=errno;
        closedir(directory);
        if(code) { errno=code; result=-1; }
        break;
      }
      case REMOVE: result=remove(args[0]); break;
      case REALPATH: {
        char *resolved=realpath(args[0],NULL);
        if(!resolved) failure(id); else { pi_reply(id,DONE,resolved,strlen(resolved),0); free(resolved); }
        continue;
      }
      case RENAME: result=rename(args[0],args[1]); break;
      case TRUNCATE: result=truncate(args[0],strtoll(args[1],NULL,10)); break;
      case FLUSH: {
        int fd=open(args[0],O_WRONLY|O_CLOEXEC);
        if(fd<0) { result=-1; break; }
        result=fsync(fd); int code=errno; close(fd); errno=code;
        break;
      }
      default: errno=ENOSYS; result=-1;
    }
    if(result<0) failure(id); else pi_reply(id,DONE,NULL,0,result);
  }
}
