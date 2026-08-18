# Worklog

逐轮完成记录。只由 `decide` 追加维护，用来让下一轮快速知道已经做过什么、为什么这样调度。

固定输出路径：`knowledge/worklog.md`。

## Records

| Round | Decision | Reason |
|---|---|---|

<!--
每轮 decide 只追加一行，例如：
| R12 | verify | 已有待研判 HYP，应先走完双向论证再开新认知。 |
-->

## 字段说明

- `Round`：`decision.yaml` 的 `round` 字段，格式建议 `R{n}`。
- `Decision`：`decision.yaml` 的 `next` 字段，即本轮选定的方向（onboard / cognize / hunt / verify / poc-verify / report）。
- `Reason`：一句话说明为什么本轮这样选择。
