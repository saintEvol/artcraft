# AGENTS.md

This file provides guidance for coding agents when working with the Artcraft monorepo.

## 禁止过度设计（用户明确要求）

- 以当前用户明确需求和已确认业务文档为边界，采用简单、直接的实现；优先复用现有机制。
- 不得以“以防万一”“未来扩展”“架构完整”为理由，擅自增加没有明确业务用途的版本号、历史记录、快照、冻结、多层抽象、重复数据表、重复状态或额外审批流程。确有明确业务要求的机制，也必须按最小必要范围实现。
- **Provider / connector 配置只保存一份当前值；修改后，所有后续调用（包括任务查询和结果收集）使用最新配置。不得引入配置修订号、历史配置、旧配置冻结或回退机制，除非用户明确改变这一要求。**
- 如有明确审计需求，记录操作人、时间和变更字段，不得借审计保留旧连接配置、旧密钥或其他敏感值。
- 新增表、状态、抽象或流程前，先核对其对应的具体业务场景。Review 必须检查过度设计，直接简化或删除无当前用途的预留字段、未使用抽象，以及没有独立业务价值的重复持久化、校验和操作流程；不得以“以后可能用到”为由保留。

## Project Overview

Artcraft is a public-facing Tauri desktop app for generating AI images and video.
It uses Rust and TypeScript. Backend services, company tooling, and website builds
live in the separate `artcraft-services` repository.

## Project Structure

```
artcraft/
├── _database/sql/artcraft_migrations/  # Embedded SQLite task database migrations
├── .sqlx/                             # SQLite query metadata for offline builds
├── crates/
│   ├── desktop/artcraft/              # Tauri app, configuration, capabilities, icons
│   ├── api_clients/                  # Desktop provider clients and shared API types
│   ├── lib/                          # Desktop support libraries
│   ├── schema/database/sqlite_tasks/ # Desktop task persistence
│   ├── schema/public/                # Shared wire-format enums and identifiers
│   ├── testing/                      # Shared test helpers
│   └── vendor/tauri-plugin-http/      # HTTP plugin fork with cookie access
├── frontend/
│   ├── apps/artcraft/                # Tauri app frontend and public resources
│   └── libs/                         # Shared frontend libraries
├── script/artcraft/                  # Desktop development and build scripts
├── test_data/                        # Fixtures used by retained crate tests
└── Cargo.toml                        # Desktop dependency workspace
```

Keep `external/` and `secrets/` untouched. Repository pruning must preserve
untracked and ignored local files; delete only Git-tracked paths unless the user
explicitly authorizes a cache cleanup.

## Code Style

- Rust with no minimum supported version
- SQLx for SQLite; prefer `sqlx::query!` / `sqlx::query_as!` compile-time checked macros over runtime `sqlx::query()` whenever possible
- A mix of wreq and reqwest for Rust HTTP clients
- Never use `println!` or `eprintln!` outside of tests; use `log` crate macros instead
- When two crates export the same type name, alias imports with a suffix: `use foo::Bar as BarFoo;`
- Prefer `use` imports over inline fully-qualified paths; only qualify inline for true one-offs or std collisions
- TypeScript with Nx, React, Vite, Zustand, and Three.js
- Use two spaces for indentation
- Each Tauri command belongs in its own file module, named after the command. Keep shared state, types, and helpers in separate support modules; see the [Storyteller command conventions](crates/desktop/artcraft/src/services/storyteller/commands/AGENTS.md).

### File Layout

Organize for top-to-bottom reading. Important things first, details later.

- **Constants** at the top (after imports)
- **Structs/enums** next; outer structs above inner sub-structs
- **API types** in order: Request, Response, Error
- **In impl blocks**: constructors first, then public methods, then private helpers
- Private helpers go *below* the methods that call them
- Among helpers: meatier logic above leaf-level formatters
- **In test modules**: constants first, then test cases (grouped into sub-modules when 2+), then helper functions last

## Markdown

- **Tables must be space-padded so columns align in plain text.** Markdown
  tables are read raw (terminals, diffs, editors) at least as often as
  rendered, and condensed tables are unreadable there. Pad every cell to its
  column width:

  ```markdown
  | Model        | Configuration | Credits    | Speed | Score   |
  |--------------|---------------|--------------------|---------|
  | Meshy 6      | text or image | 104        | 80.0  | +24     |
  | Rodin 2.5    | text or image | 13         | 10.0  | +3      |
  ```

  Not: `| Model | Configuration | Credits | Speed | Score |` packed tight
  with varying widths per row.
