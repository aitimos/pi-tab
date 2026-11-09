.PHONY: help install build test test-mcp test-model-settings verify
help:
	@echo "install   安装锁定依赖（Node 24）"
	@echo "build     构建书签与扩展"
	@echo "test      运行单元测试"
	@echo "test-mcp  验证真实构建的 MCP 书签与扩展界面"
	@echo "test-model-settings  验证 Pi 设置中的模型配置"
	@echo "verify    检查构建包与版本一致性"
install:
	npm ci
build:
	npm run build
test:
	npm test
test-mcp:
	npm run test:mcp
test-model-settings:
	npm run test:model-settings
verify:
	node scripts/release.mjs verify
