.PHONY: help install build test test-mcp verify
help:
	@echo "install   安装锁定依赖（Node 24）"
	@echo "build     构建书签与扩展"
	@echo "test      运行单元测试"
	@echo "test-mcp  验证真实构建的 MCP 书签与扩展界面"
	@echo "verify    检查构建包与版本一致性"
install:
	npm ci
build:
	npm run build
test:
	npm test
test-mcp:
	npm run test:mcp
verify:
	node scripts/release.mjs verify
