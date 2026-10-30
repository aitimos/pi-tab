# Extension 内置 Linux

每个会话独立使用 Linux Wasm，首次文件或命令操作时启动。默认目录 `/workspace`；刷新网页不会重建实例，扩展重载、后台页面重建、浏览器退出、删除或重置会话会丢弃其临时文件。子 agent 不继承文件。

`bash` 是 Pi 工具名称，实际解释器是 BusyBox `/bin/sh`，不是 GNU Bash。此版本没有网络工具挂载、本机目录访问、文件持久化或交互式终端。

## 重建资源

安装 Docker 后，在仓库运行 `bash scripts/build-linux.sh`。首次编译包含修改过的 LLVM、Linux、musl 和 BusyBox，耗时较长，并需要数 GB 的构建空间。构建缓存保存在专用 Docker volume `pi-tab-linux-build`，不会放入扩展。修改 `versions.env` 后需要使用新的构建 volume，不能沿用旧版本的完成标记。

普通 `npm run build` 只校验 `resources.json` 并复制已构建的资源，不联网下载或重编 Linux。输出中的 `linux/` 必须完整保留。

源码版本见 `versions.env`。上游项目：https://github.com/joelseverin/linux-wasm 。其工具链、内核分别来自 https://github.com/joelseverin/llvm 和 https://github.com/joelseverin/linux；musl 来自 https://git.musl-libc.org/git/musl，BusyBox 来自 https://git.busybox.net/busybox。构建脚本取对应提交，并应用固定上游源码中的 musl/BusyBox 补丁。Docker 基础镜像固定 digest，系统构建依赖固定到 Debian 2026-10-30 快照。

`vendor/` 保留修改后的上游运行代码和许可证，`runtime.patch` 记录相对上游的修改；`bridge.c` 与 `init` 是本项目加入初始文件系统的源码。`assets/` 包含内核、初始文件系统及各自的许可证。Linux 和运行代码采用 GPL-2.0-only，musl 使用其 COPYRIGHT 中的许可证；不要把这些文件重新标为项目的 Apache-2.0。

`patches/0001-userspace-stack.patch` 将用户程序栈从 8 KiB 增至 256 KiB。真实扩展中测得 BusyBox `seq` 的 musl 浮点输出调用使用 8,512 字节；上游的 8 KiB 栈会越界并改坏 RAM 文件内容。通信程序的参数表也放在静态内存中，编译时拒绝超过 2 KiB 的单函数栈帧。

完整对应源码保留在构建 volume 内。运行 `bash scripts/export-linux-sources.sh` 可离线导出到 `linux/sources/`：包含上游运行项目、内核、已应用上游补丁的 musl/BusyBox、LLVM 及本项目补丁和构建脚本。分发二进制时应同时提供这些源码归档；普通扩展构建不需要读取或下载源码。源码目录不提交到 Git。

## 验证

`npm run test:linux` 在真实 Chrome 扩展的 offscreen 页面启动内核，检查管道、UTF-8、字节读写、退出码、取消、超时、连续大输出、隔离、刷新和重置。`npm run test:linux-tools` 使用本地模型服务实际调用四个工具，并检查会话记录和界面。两者都需要设置 `PI_TAB_TEST_CHROME` 为 Chrome for Testing 可执行文件。

## 通信

后台页面管理 Worker；Linux 内的 `/sbin/pi-bridge` 使用专用 host imports 读取请求、发送响应和检查取消。邮箱头是两个原子 32 位整数（请求长度、取消请求 ID），后面是最多 1 MiB 的请求。

请求包含四个 little-endian uint32：ID、操作、参数数、数据字节数；接着是 NUL 分隔的 UTF-8 参数，最后是原始文件字节。回复包含 ID、种类、状态和 Uint8Array。种类 0/1/2/3/4/5 分别表示就绪、stdout、stderr、完成、errno 错误和文件数据。输出与控制信息分开，不解析终端提示符。

每个实例串行处理请求，不同会话可分别执行。命令在独立进程组中运行；取消先发 SIGTERM，250ms 后仍未退出则发 SIGKILL。文件句柄设置 CLOEXEC，命令不会继承文件工具打开的句柄。普通命令不继承上一条命令的 cwd 或 export，但读写同一 Linux 文件系统。

未来挂载约定见 [命令挂载文档](../docs/linux-command-mounts.md)。该约定本次不提供运行时实现。
