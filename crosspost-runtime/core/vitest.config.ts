import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // 测试文件串行：多个文件会写 CROSSPOST_CUSTOM_STYLES_DIR 环境变量，并行会互相干扰
    fileParallelism: false,
    // 单测超时放宽到 30s：封面/结束语用例要经 sharp 栅格化 10 套样式（`p2.test.ts` 里一次跑完），
    // 默认 5s 在机器忙（并发跑多份验证）时会被误判超时——那是**基础设施抖动，不是行为回归**。
    // 放宽的是等待上限，断言强度不变。
    testTimeout: 30000,
    // 覆盖率门槛（2026-09-28 测试审计上调）：原门槛是 52/52/46/60，而实测已经到
    // 67.5/67.5/60.6/65.7 —— 门槛离实测 15 个点，等于**没有门**：删掉一整套测试也照样绿。
    // 现在取"实测低 4 个点"，落地即绿、但真的能挡住回退。
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      thresholds: {
        lines: 63,
        statements: 63,
        functions: 56,
        branches: 62,
      },
    },
  },
})
