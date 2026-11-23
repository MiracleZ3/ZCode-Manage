#!/usr/bin/env node

// 开发时同时起四个应用进程，由根目录的 pnpm dev 调用。
//
// 环境不在这里读：package.json 里的 dev:apps 用 node 自带的 --env-file 把
// deploy/dev/apps.env 读进了本进程的环境，这里起的应用进程原样继承。
// 之所以不把 --env-file 写在各应用的启动命令里：那条命令由打包工具的监听模式执行，
// 它用的命令运行器会把以 ../../ 开头的词当成要执行的程序，命令就被改坏了。
// 应用自身始终不读 .env 文件，只从进程环境取配置。

import concurrently from "concurrently";
import { resolve } from "node:path";

// 名字、日志前缀的颜色、应用目录。
const apps = [
  ["console", "yellow", "console"],
  ["api", "blue", "manage-api"],
  ["gateway", "green", "model-gateway"],
  ["mock", "magenta", "mock-model"],
];

const { result } = concurrently(
  apps.map(([name, prefixColor, directory]) => ({
    command: "pnpm run dev",
    name,
    prefixColor,
    // 每个应用在它自己的目录里起，构建产物的相对位置与单独执行时一致。
    cwd: resolve(import.meta.dirname, "../apps", directory),
  })),
  // 任何一个进程退出都带停其余的，与命令行上的 -k 一致。有进程没正常退出时，本进程以 1 退出。
  { killOthersOn: ["failure", "success"] },
);

result.then(
  () => process.exit(0),
  () => process.exit(1),
);
