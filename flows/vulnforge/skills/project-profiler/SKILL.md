---
name: Project Profiler
description: 项目画像技能 — 收集项目客观事实（代码统计、技术栈、项目结构），产出 profiler.yaml。
---

# Project Profiler

## 目标

对目标项目做快速画像，产出一份客观事实清单。不做安全判断、不做类型分类，只收集数据。

## 工作流程

### Step 1：运行扫描脚本

```bash
python3 <skill_path>/profile-basic-scan.py <项目路径>
```

脚本自动收集：
- 文件数量、代码行数
- 按语言统计的代码行分布
- 主要目录结构
- 依赖文件内容（package.json / go.mod / requirements.txt 等）
- 入口文件和路由文件

### Step 2：补充项目结构信息

脚本无法自动识别的信息需要手动补充：
- monorepo 的子包列表（从 workspace 配置读取）
- 构建系统类型
- 主要依赖列表（从依赖文件中提取关键项）

### Step 3：产出 profiler.yaml

基于脚本输出和手动补充，写入 profiler.yaml。所有数值字段用精确数字，不要用近似值。

### Step 4：创建 wiki 框架

基于 profiler 数据创建初始 wiki：

- **wiki/index.md**：wiki 索引，初始为空模板，后续 scan 逐步填充
- **wiki/overview.md**：项目概述，基于 profiler 数据写成人类可读的概述文档
