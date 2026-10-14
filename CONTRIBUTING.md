# 参与截图晾衣架

欢迎报告问题、改进使用说明，或提交功能和代码建议。

## 报告问题

请在 [Issues](https://github.com/woxicaocao/screenshot-clothesline/issues) 提供软件版本、Windows 版本、显示缩放、操作步骤、预期结果和实际结果。涉及剪贴板、文件或便签时，请使用可公开的示例内容。

## 修改与验证

先阅读 [使用手册](docs/使用手册.md)，了解图片收集、手动粘贴、原图导出、便签保存与自动隐藏的现有行为。较大的功能改动建议先在 Issue 中说明用途和操作设计。

```powershell
npm ci
npm test
```

按改动范围运行对应 smoke：

```powershell
npm run smoke
npm run smoke:notes
npm run smoke:appreciation
```

这些 smoke 使用隔离数据。真实 Windows 鼠标、显示缩放、微信拖放和系统剪贴板行为需要相应的人工检查。

提交时说明解决的问题、最终行为与验证结果。不要提交依赖目录、构建产物、个人截图、便签数据或访问凭据。请保留用户数据与已有行为的兼容性。

贡献的代码按本项目 [MIT 许可证](LICENSE) 发布。
