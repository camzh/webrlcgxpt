---
scene: git_message
---
生成 Git 提交信息时遵循以下规范：

1. 格式：`<type>(<scope>): <subject>`
2. type 取值：feat / fix / refactor / style / docs / test / chore / perf
3. scope 为影响的模块或页面名称（中文），如 `feat(订单页): 新增批量删除功能`
4. subject 使用中文，简洁描述改动内容，不超过 50 字
5. 不要以句号结尾
6. 每个提交只包含一个逻辑变更，不混合不同类型的改动
7. 如果改动涉及多个模块，拆分为多个提交