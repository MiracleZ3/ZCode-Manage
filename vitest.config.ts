import { defineConfig } from "vitest/config";

export default defineConfig({
  // 构建期常量在测试态由这里注入；真实值由各应用的 tsup.config.ts 决定。
  define: {
    __ZM_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    // 测试放在各包的 test/ 目录，与源码分开，不进入 tsc 的编译范围。
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    // 通过的用例不转发 console 输出，避免日志把门禁输出刷爆；失败用例的日志原样保留。
    silent: "passed-only",
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
  },
});
