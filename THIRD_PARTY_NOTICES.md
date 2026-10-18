# 第三方内容与素材声明

## 依赖代码

项目通过 npm 锁文件安装依赖，不发布 node_modules、依赖二进制或构建包。完整 139 项锁文件许可记录见 [依赖清单](docs/DEPENDENCIES.md)，实际安装数量随平台变化。

Fastify、Zod、docx、parse5、PDFKit 等锁文件标注 MIT；PDF.js、TypeScript 等标注 Apache-2.0。JSZip 3.10.2 的包内许可允许选择 MIT 或 GPL，本项目选择 MIT 条件使用；pako 标注 MIT AND Zlib，sax 标注 BlueOak-1.0.0，其余 BSD/ISC/0BSD 记录单列。png-js 2.0.0 的锁文件缺 license 字段，已复核安装包 LICENSE 为 MIT，不将缺字段视为无许可。

上列为安装与来源清单，不代替每个包随附的完整版权声明。若将来将依赖打包分发，需要重新核对完整许可与适用 NOTICE；当前没有把第三方库复制进自有源码。

## 字体

- 文件：`assets/fonts/NotoSansCJKsc-Regular.otf`，未修改的 Noto Sans CJK SC Regular 静态字体。
- 来源：[Noto CJK 官方仓库](https://github.com/notofonts/noto-cjk/tree/main/Sans)。
- 许可：SIL Open Font License 1.1，官方许可原文完整保留在 [OFL.txt](assets/fonts/OFL.txt)。字体不能作为独立商品出售；修改/再分发须遵守 OFL。
- 字体内置版权声明：© 2014-2021 Adobe (http://www.adobe.com/)。官方 LICENSE 原文随附，字体内版权信息保持不变。
- SHA-256：`2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b`。
- PDF 由该字体生成，未携带 Windows SimHei、原演示 PDF 或其他许可未明的嵌入字体。网页只使用浏览器/操作系统已有字体，不附字体文件之外的字体素材。

## 法律正文与法源

`demo/legal-excerpts.txt` 仅收录《中华人民共和国民法典》第675、679条正文的人工核对摘录，来源为 [最高人民法院公开转载](https://www.court.gov.cn/zixun/xiangqing/233181.html)，来源记录见 [demo/source.json](demo/source.json)。未复制网页页面、照片、图标、编辑解读或整库内容。

发布依据是《著作权法》第5条第1项关于法律等文件不适用该法的规定，核对来源为 [国家版权局公布的法律正文](https://www.ncac.gov.cn/xxfb/flfg/flfg_532/202103/t20210309_50530.html)。此依据仅用于法律正文，不扩张到整个官网内容。

这两条是流程演示的历史摘录，不是完整法律文本、现行效力证明或个案适用性审查。Demo 中 validityStatus 始终为 UNKNOWN；收集时间不代表已独立证明其现行有效。

## 项目编写的材料与图形

- `demo/materials/*.txt` 和固定 Demo 模型替身在本次导出中重新编写，人物、交易、日期与对话为合成设定；不含原项目案件或历史模型响应。
- `docs/assets/*.png` 来自本副本本地页面的实际浏览器截图，不采集桌面、其他应用/标签、账户信息或真实案件；保留 OFFLINE/替身/效力未核标识。
- 页面中的简单几何 SVG 符号在本次导出中重新绘制，没有携带原来源未核的图标集合；没有外部图库、人物照片或平台商标素材。
- 材料准备提纲为项目自拟，不再分发或依赖原法院模板 HTML，也不称为官方诉状样式。

## 明确未分发

原案件/材料/报告、完整模型请求响应、账户诊断、法源 SQLite 与快照、官网 HTML、旧截图与视频、系统字体、内部文档/日志、原 Git 历史及恢复引用均不在公开清单内。
