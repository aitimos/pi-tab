// SPDX-License-Identifier: GPL-2.0-only
// curl's Linux process owns all file descriptors. The host requests bounded IO;
// poll/usleep yield to Linux, so blocked pipes remain cancellable by signals.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((import_module("env"), import_name("pi_command_start")))
extern void pi_command_start(const void *buffer, int length, int argc, int group);
__attribute__((import_module("env"), import_name("pi_command_receive")))
extern int pi_command_receive(void *buffer, int capacity, int *operation, int *fd);
__attribute__((import_module("env"), import_name("pi_command_reply")))
extern void pi_command_reply(const void *buffer, int length, int status);

static char metadata[1024*1024];
static unsigned char bytes[65536];
extern char **environ;

int main(int argc, char **argv) {
  if (!getcwd(metadata, sizeof(metadata))) { perror("curl: getcwd"); return 2; }
  size_t used=strlen(metadata)+1;
  int envc=0;
  while(environ[envc]) envc++;
  for(int i=0;i<argc+envc;i++) {
    const char *value=i<argc?argv[i]:environ[i-argc];
    size_t length=strlen(value)+1;
    if(length>sizeof(metadata)-used) { fputs("curl: arguments exceed 1 MiB\n",stderr); return 2; }
    memcpy(metadata+used,value,length); used+=length;
  }
  pi_command_start(metadata,used,argc,getpgrp());
  while(1) {
    int operation=0,fd=0;
    int received=pi_command_receive(bytes,sizeof(bytes),&operation,&fd);
    if(!received) { usleep(1000); continue; }
    int length=received-1, result=-1, output=0;
    // Do not set O_NONBLOCK on inherited descriptors: the shell and other
    // children share their flags. Poll and write at most PIPE_BUF instead.
    if(operation==1 || operation==2) {
      struct pollfd stream={fd,operation==1?POLLIN:POLLOUT,0};
      int ready=poll(&stream,1,0);
      if(ready<=0) { pi_command_reply(NULL,0,ready<0?-errno:-EAGAIN); continue; }
    }
    switch(operation) {
      case 1: // read
        do { result=read(fd,bytes,sizeof(bytes)); } while(result<0 && errno==EINTR);
        if(result>=0)output=result;
        break;
      case 2: { // Partial writes are resumed by the host after pipe consumption.
        do { result=write(fd,bytes,length>PIPE_BUF?PIPE_BUF:length); } while(result<0 && errno==EINTR);
        break;
      }
      case 3: case 5: // open input/output file, path includes NUL
        if(!length || bytes[length-1]) { errno=EINVAL; break; }
        result=open((char *)bytes,operation==3?O_RDONLY|O_CLOEXEC|O_NONBLOCK:O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC|O_NONBLOCK,0666);
        break;
      case 4: result=close(fd); break;
      case 6: pi_command_reply(NULL,0,0); return fd;
      default: errno=EINVAL; break;
    }
    pi_command_reply(bytes,output,result<0?-errno:result);
  }
}
