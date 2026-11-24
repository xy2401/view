# view
Browser is only you have

View 是一个只读文件浏览器。桌面端可以打开、收藏和共享本地文件夹，静态网页版可以添加 HTTP autoindex 或 WebDAV 地址。局域网里的 iPad 可以通过浏览器查看电脑共享的全部目录。

## 本地运行

使用 Node.js 22.13 或更高版本和 pnpm 11.25.0，在仓库根目录安装依赖。

```sh
pnpm install --frozen-lockfile
```

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 启动网页版开发服务器，在「添加位置」中输入远程目录地址。 |
| `pnpm desktop` | 构建共享界面并启动 Electron。首次启动会下载当前平台的 Electron。 |
| `pnpm build` | 检查 TypeScript 并生成静态站点，可将 `apps/web/dist/` 整个目录部署到 Web 服务器。 |
| `pnpm package:desktop` | 在 `dist/desktop/` 生成当前平台的桌面应用目录。 |
| `pnpm test` | 验证文件头识别、模型取样、桌面目录和 HTTP 共享服务。 |
| `pnpm test:browser` | 构建网页，使用 Chromium 打开真实文件并验证 Magika 识别。首次运行可用 `pnpm exec playwright install chromium` 安装浏览器，或用 `VIEW_CHROMIUM_PATH` 指定已有的 Chromium 可执行文件。 |

## 打开后缀缺失或标错的文件

点开文件时，View 请求开头的 4 KiB 来选择查看器。例如，一份名叫 `旅行.jpg` 的 PDF 会进入 PDF 查看器，无后缀的 PNG 可以直接看图。浏览目录列表时只读取目录。列表和网格里的文件图标仍按名称匹配，网格会读取可见图片以显示缩略图。

预览底部的「识别格式」可用 Magika 进一步判断文件类型。模型随应用分发，点按钮后才在本机的 Worker 中加载。对支持 Range 的大文件，识别时只取首尾各 4 KiB；只有完整内容不超过 8 KiB 时，才能在不支持 Range 的来源上运行模型。识别出可用的其他查看器时，可以直接切换。

## 从 iPad 看电脑上的照片

1. 在桌面端打开照片目录，点「HTTP 共享」。点「收藏」可以把目录固定在桌面首页，两项设置独立保存。
2. 进入「共享管理」，点「开启共享服务」。同一局域网内的 iPad 可以打开显示的地址并输入访问密钥，也可以扫码配对。
3. 登录后先看到所有已共享的目录。进入任意目录，点开照片即可预览。桌面端关闭某个目录的共享后，该目录下的旧链接也会失效。

独立部署的静态网页可以在「添加位置」中选择 HTTP autoindex 或 WebDAV。添加的地址保存在当前浏览器。两种网页版使用相同的目录和预览界面。

[View 第一版设计](docs/design.md)
