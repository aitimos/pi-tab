# 未来的 Linux 命令挂载接口

本文定义后续实现的约定。当前版本没有命令注册器、可执行代理、`mountCommand` 或 `unmountCommand` 运行时导出，也没有 `curl → fetch`。

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

未来的实现会在 `/mnt/tools/bin` 创建可执行代理，并把此目录加入 `PATH`。管道、重定向、引号展开和工作目录由 Linux 处理，不在 JS 中重新解析整条 shell 命令。注册方负责把参数转换成其 tool 所需的数据，不自动把全部 Pi 工具暴露成命令。

例如将来注册 `curl` 后，`curl https://example.com/data | grep title > result.txt` 的处理过程应为：Linux 执行代理 → 对应 JS handler 读取 argv → handler 使用 fetch 请求地址 → 响应字节写入 stdout → Linux 将字节交给 grep 并写入文件。curl 参数支持哪些选项、请求凭证如何处理，需要在真正实现 curl 时单独确定；这里不承诺完整 curl 兼容。
