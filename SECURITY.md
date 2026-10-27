# 安全政策 / Security Policy

## 支持的版本

安全修复优先发布到最新正式版本。请先检查 [Releases](https://github.com/aitimos/pi-tab/releases)。旧版本不单独维护安全更新。

Security fixes target the latest stable release. Older versions do not receive separate security updates.

## 私密报告漏洞

使用 GitHub 的 [Report a vulnerability](https://github.com/aitimos/pi-tab/security/advisories/new) 提交私密报告。请勿将尚未修复的漏洞细节、API Key、Cookie、私人会话或包含密钥的书签放入公开 Issue。

请包含：受影响版本、书签或扩展模式、浏览器版本、复现步骤、实际影响，以及去除敏感数据后的最小示例。只在自己的或获授权的环境验证。

维护者会通过报告讨论串跟进复现、修复和披露安排；项目目前不承诺固定响应时限或漏洞奖励。

Use [private vulnerability reporting](https://github.com/aitimos/pi-tab/security/advisories/new) for security issues. Include the affected version, browser, operating mode, reproduction steps and impact. Do not publish secrets or exploit details in public issues. There is no guaranteed response time or bounty program.

## 使用时的安全边界

Pi Tab 可以读取和操作网页，执行 JavaScript，并把任务所需内容发送到你配置的模型接口。书签配置可能包含 API Key；浏览器同步和分享完整书签会一并传递这些配置。停止任务不会撤销已完成的页面操作。

普通安装、兼容性和界面问题请使用 [问题反馈](https://github.com/aitimos/pi-tab/issues/new/choose)。
