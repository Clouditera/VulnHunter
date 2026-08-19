# jar/war 预处理（反编译）

环境已提供 OpenJDK 17（`java`）与 `/opt/vulnhunter/bin/vineflower.jar`。

## 用法

```
java -jar /opt/vulnhunter/bin/vineflower.jar <输入jar或class目录> <输出目录>
```

jar/war 可直接输入；fat jar（spring boot）与 war 建议先 `unzip` 展开再对业务目录处理。

## 分类口径

- **业务码**（反编译到 `<work_dir>/.vulnhunter-decompiled/<jar名>/`）：
  `BOOT-INF/classes`、`WEB-INF/classes`、独立业务 jar（无公共 groupId 的 pom.properties）。
- **依赖**（不反编译，登记即可）：`BOOT-INF/lib`、`WEB-INF/lib` 内的 jar、
  `META-INF/maven/**/pom.properties` 带公共 groupId（org.apache./org.springframework./com.fasterxml. 等）的独立 jar。
- 反编译产物（.java 树）即后续审计输入；依赖登记进 worklog 或 wiki 即可。
- 大项目优先反编译业务核心包，依赖树不必展开。
