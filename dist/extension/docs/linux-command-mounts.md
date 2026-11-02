# Linux curl 与未来的命令挂载接口

当前已内置 `/mnt/tools/bin/curl`，通过扩展后台的 JS `fetch` 发出 HTTP(S) 请求。不需要本地服务端，也不依赖宿主机安装 curl。它是支持常用参数的适配器，不是完整的 libcurl。

```sh
curl -fsSL https://example.com/data | grep title > result.txt
curl --json '{"text":"你好"}' -H 'Authorization: Bearer TOKEN' https://example.com/api
printf 'hello' | curl --data-binary @- https://example.com/upload
curl --data-binary '@file with spaces.bin' https://example.com/upload
curl -L -o download.bin https://example.com/file
```

`curl --help` 列出支持项：`-X/--request`、`-H/--header`、`-d/--data`、`--data-raw`、`--data-binary`、`--json`、`-I/--head`、`-i/--include`、`-o/--output`、`-L/--location`、`-f/--fail`、`--fail-with-body`、`-s/--silent`、`-S/--show-error`、`-m/--max-time`、`-u/--user` 和 `--url`。支持组合短参数（如 `-fsSL`），每条命令只接受一个 URL。不显示进度条；未知参数明确报错。`-u` 必须提供 `用户:密码`，不弹出交互式密码提示。

路径和 stdin/stdout/stderr 都属于当前会话的 Linux。`-o -` 写到 stdout；`@-` 读取 stdin。`--data @文件` 会去掉 CR、LF 和 NUL，`--data-binary @文件` 原样保留字节；`--data-raw` 把开头的 `@` 当普通字符。上传内容先读入浏览器内存，下载按块写入 Linux，等待接收端消费后再继续。

网络请求使用扩展的 HTTP(S) 主机权限，不自动携带浏览器 Cookie，不读取代理环境变量。不支持 `-k`、代理、Cookie 文件、FTP 或本机文件访问。TLS、受限制的请求头和响应解压由浏览器控制；例如 Cookie、Host、Content-Length、User-Agent 请求头会明确拒绝，`-A/--user-agent` 也不支持。`-i/-I` 根据 fetch 提供的信息生成响应头，不能还原线上 HTTP 版本和原始头顺序。浏览器隐藏手动重定向响应，因此遇到重定向且未指定 `-L` 时返回错误 47。

HTTP 400/500 默认仍输出正文并成功退出；`-f` 返回 22 且不输出正文，`--fail-with-body` 返回 22 并保留正文。参数错误返回 2，连接失败返回 7，读输入文件失败返回 26，写输出失败返回 23，接收响应中断返回 56，`--max-time` 超时返回 28。Pi 停止任务、命令被信号终止或会话销毁都会取消 fetch；提前关闭下游管道（如 `head`）也会结束请求。

Linux 代理由 `linux/command.c` 编译。它通过独立的共享缓冲区接收 JS 请求，在 Linux 中执行有界的读写，再把结果传回后台。这个通道独立于文件工具请求，避免 shell 等待 curl 时阻塞其自身读写。每个 curl 进程使用独立通道。

## 未来的通用接口

下面仍是后续实现约定。当前没有通用命令注册器、`mountCommand` 或 `unmountCommand` 运行时导出；内置 curl 不会把其他 JS tool 自动暴露为命令。

挂载属于一个会话的 Linux 实例。计划使用：

```ts
type CommandHandler = (call: {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: AsyncIterable<Uint8Array>;
  stdout: (bytes: Uint8Array) => Promise<void>;
  stderr: (bytes: Uint8Array) => Promise<void>;
  signal: AbortSignal;
  site: string;
  conversationId: number;
}) => Promise<{ exitCode: number }>;

interface PlannedCommandMounts {
  mountCommand(command: { name: string; handler: CommandHandler }): Promise<void>;
  unmountCommand(name: string): Promise<void>;
}
```

`argv` 是 Linux shell 已解析的参数，不包含命令名。处理函数接收字节流，支持二进制输入输出。写入函数返回的 Promise 用于等待接收端消费数据；取消信号跟随本次 Linux 命令。退出码交回 shell，不能把 JS 异常当作成功。

`/mnt/tools/bin` 已加入 `PATH`；未来通用注册器也会在此目录创建可执行代理。管道、重定向、引号展开和工作目录由 Linux 处理，不在 JS 中重新解析整条 shell 命令。注册方负责把参数转换成其 tool 所需的数据，不自动把全部 Pi 工具暴露成命令。

内置 curl 已实现：Linux 执行代理 → JS 读取 argv → fetch 请求地址 → 响应字节写入 stdout → Linux 将字节交给管道或文件。当前代理内部还支持由 curl 请求读写 Linux 文件；这些内部操作不是通用挂载接口的公开扩展。
