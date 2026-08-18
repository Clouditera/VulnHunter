# CWE 漏洞类型速查

填写报告 `metadata.cwe` 与判定 `vuln_type` 时参考。每条给出 CWE 编号、一句话定义与适用场景。不确定时按"漏洞的核心缺陷动作"匹配，而非表面现象。

> 完整定义查 https://cwe.mitre.org/data/definitions/<编号>.html

## 注入类

| vuln_type | CWE | 定义 / 适用 |
|---|---|---|
| sqli | CWE-89 | SQL 注入：未净化输入拼入 SQL 语句 |
| cmdi | CWE-78 | OS 命令注入：输入流入 shell/exec |
| codei | CWE-94 | 代码注入：输入被当作代码执行（eval 类） |
| xss | CWE-79 | 跨站脚本：未转义输出进入 HTML/JS 上下文 |
| ldapi | CWE-90 | LDAP 注入 |
| xpathi | CWE-643 | XPath 注入 |
| httpi | CWE-113 | HTTP 响应头注入 / 拆分 |
| xxe | CWE-611 | XML 外部实体引用 |
| deser | CWE-502 | 不可信数据反序列化 |
| proto | CWE-1321 | 原型链污染 |

## 内存安全类（C/C++ 常见）

| vuln_type | CWE | 定义 / 适用 |
|---|---|---|
| bof | CWE-787 / CWE-125 | 缓冲区越界写 / 越界读（写用 787，读用 125） |
| heap | CWE-122 | 堆缓冲区溢出 |
| intovf | CWE-190 / CWE-191 | 整数溢出（190）/ 整数下溢（191）；位域截断、回绕导致后续越界或逻辑错误 |
| uaf | CWE-416 | 释放后使用 |
| memleak | CWE-401 | 内存泄漏 |
| nullptr | CWE-476 | 空指针解引用 |
| fmtstr | CWE-134 | 格式化字符串 |
| race | CWE-362 | 竞态条件（TOCTOU 等） |

> 整数问题常是"因"，越界是"果"。若根因是整数溢出/截断导致后续越界，主类型按根因标 intovf(CWE-190)，越界后果在 dataflow 里描述。

## 访问控制 / 认证类

| vuln_type | CWE | 定义 / 适用 |
|---|---|---|
| idor | CWE-639 | 越权访问：直接对象引用未校验归属 |
| auth | CWE-287 | 认证缺陷：认证逻辑可绕过 |
| csrf | CWE-352 | 跨站请求伪造 |
| redirect | CWE-601 | 开放重定向 |
| path | CWE-22 | 路径遍历 |
| upload | CWE-434 | 危险文件上传 |
| ssrf | CWE-918 | 服务端请求伪造 |
| sandbox | CWE-265 | 沙箱/权限边界逃逸 |

## 信息暴露类

| vuln_type | CWE | 定义 / 适用 |
|---|---|---|
| info | CWE-200 | 敏感信息暴露 |

## 拒绝服务（作为后果维度）

DoS 通常是上述缺陷的后果而非独立类型。若漏洞主要后果是拒绝服务（崩溃、资源耗尽、死循环），主类型按根因标注（如 intovf / nullptr），并在标题与影响里写明"导致拒绝服务"。不可控资源消耗可参考 CWE-400。

## 找不到匹配时

用 `other`，并在标题与 detailed_description 里把缺陷本质讲清楚。宁可标 other 讲清楚，也不要硬套一个不贴切的类型。
