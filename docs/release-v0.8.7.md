# 截图晾衣架 0.8.7 · 本机图片拖入

**从文件夹选中图片，拖到晾衣架上，松开就挂好了。**

## 先了解「自动捕捉」

工具栏显示 **暂停**，表示正在自动收集剪贴板中的新图片；显示 **继续**，表示已暂停。照常用 Windows、微信等工具截图，只要新图片进入剪贴板，晾衣架就会自动保存并挂上。启动或恢复收集时跳过已有剪贴板图片，重复图片不会反复添加。

暂停只影响自动捕捉，仍可拖入本机图片、点击「粘贴」或悬停衣架按 Ctrl+V 手动挂图。

## 新增：本机图片拖入

- 从 Windows 文件夹拖入一张或多张 **PNG、JPG/JPEG、WebP**，保存成功后挂到衣架左端。
- 导入保存独立副本，**不修改、移动或删除来源文件**。预览和拖出使用原文件内容，衣架显示小缩略图。
- 图片按内容和尺寸去重；无效文件、其他格式或保存失败会提示，可重新拖入重试。
- 拖入期间临时保持展开，结束后恢复自动隐藏。请拖到展开衣架的工具栏、绳子或卡片区域。
- 批量图片逐张读取和解码，不新增常驻窗口或后台服务。

## 下载与升级

**Windows 10 / 11 x64 请下载 [screenshot-clothesline-0.8.7-win-x64.zip](https://github.com/woxicaocao/screenshot-clothesline/releases/download/v0.8.7/screenshot-clothesline-0.8.7-win-x64.zip)**，完整解压后双击「截图晾衣架.exe」，无需安装 Node.js。

先从托盘退出旧版，再运行新版。原图、便签和设置继续使用 `%APPDATA%\screenshot-clothesline`，旧版与用户数据保留。

源码采用 MIT 许可证。附件 `USER-GUIDE.md` 为使用说明，`SHA256SUMS.txt` 用于验证下载完整性；源码 ZIP 供开发者使用。

[项目介绍](https://github.com/woxicaocao/screenshot-clothesline) · [在线详情与已有功能演示](https://woxicaocao.github.io/screenshot-clothesline/showcase/) · [问题反馈](https://github.com/woxicaocao/screenshot-clothesline/issues)
