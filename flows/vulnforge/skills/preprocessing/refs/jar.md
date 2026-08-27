# jar/war 预处理（反编译）

环境已提供 OpenJDK 17（`java`）与 `/opt/vulnhunter/bin/vineflower.jar`。

## 用法

```
java -jar /opt/vulnhunter/bin/vineflower.jar <输入jar或class目录> <输出目录>
```

jar/war 可直接输入；fat jar（spring boot）与 war 建议先 `unzip` 展开再对业务目录处理。

## 分类口径

- **业务码**（反编译到**源码目录** `src/.vulnhunter-decompiled/<jar名>/`——即 `/workspace/src/` 下，不是 out/ 输出目录；平台会把 src/ 增量同步进源码视图，放错位置用户看不到）：
  `BOOT-INF/classes`、`WEB-INF/classes`、独立业务 jar（无公共 groupId 的 pom.properties）。
- **依赖**（不反编译，登记即可）：`BOOT-INF/lib`、`WEB-INF/lib` 内的 jar、
  `META-INF/maven/**/pom.properties` 带公共 groupId（org.apache./org.springframework./com.fasterxml. 等）的独立 jar。
- 反编译产物（.java 树）即后续审计输入；依赖登记进 worklog 或 wiki 即可。
- 大项目优先反编译业务核心包，依赖树不必展开。

## 反编译清单（manifest，必须生成）

每个 jar/war 反编译完成后，**必须**立即运行清单生成脚本（固定算法，禁止手写 manifest JSON）：

```
python3 /opt/vulnhunter/bin/gen-decompile-manifest.py <jar或展开目录> <该 jar 的反编译输出目录> <manifest 路径>
```

例：

```
python3 /opt/vulnhunter/bin/gen-decompile-manifest.py \
  /workspace/src/.vulnhunter-unpacked/manager-core.war \
  /workspace/src/.vulnhunter-decompiled/manager-core.war \
  /workspace/src/.vulnhunter-decompiled/manifest.json
```

- manifest 固定位于 `src/.vulnhunter-decompiled/manifest.json`，随 src/ 增量同步进平台源码视图；
- 脚本自动处理内部类（`Bar$Inner.class` → `Bar.java`）与多 jar 合并（同一 manifest 按 jar 名去重更新），重复执行幂等；
- 用途：平台查看器凭它把 `.class` 请求确定性映射到对应 `.java`（未写入 entries 的依赖类不映射，保持二进制展示）；
- 若脚本不存在或失败，重试一次；仍失败则照常继续审计，并在 worklog 记录（平台会回退到启发式路径匹配，不影响扫描）。
