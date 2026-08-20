---
name: Preprocessing
description: 上传物预处理技能 — 按 onboard 第 1 步的识别结果执行预处理（jar/war/裸 class 反编译、嵌套压缩包解压），不做编译与执行。
---

# Preprocessing

按 onboard 第 1 步识别的项目类型选择对应参考文件执行预处理；目前仅 jar 一类。

- 项目含 `.jar` / `.war` / 裸 `.class` → 读 `refs/jar.md` 并按其执行。
- 其余类型：无标准预处理，按需轻量处理（如解压嵌套压缩包）即可。

所有阶段禁止编译、安装依赖、执行项目代码或测试。
