# @335g/pi-git

[![npm version](https://img.shields.io/npm/v/@335g/pi-git.svg)](https://www.npmjs.com/package/@335g/pi-git)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) extension that adds a `/commit` command for generating [Conventional Commits](https://www.conventionalcommits.org/) messages using LLM or heuristic fallback.

## Features

- **`/commit` command** – Stage all changes and generate a commit message in one step
- **Inline message support** – `/commit fix typo` uses the message directly without AI generation
- **AI-powered generation** – Leverages pi's LLM to produce Conventional Commits messages from staged diffs
- **Heuristic fallback** – When the LLM is unavailable, generates a commit message from diff analysis
- **Language support** – Commit body can be written in English or Japanese (configured via `.pi-git/config.toml`)
- **Interactive confirmation** – Review, edit, or cancel the proposed commit message before executing
- **Merge conflict detection** – Refuses to commit when a merge is in progress

## Installation

```bash
pi install @335g/pi-git
```

Or add it to your pi package config:

```json
{
  "packages": {
    "@335g/pi-git": "latest"
  }
}
```

## Usage

### Basic commit

In a pi session, inside a git repository:

```
/commit
```

This will:
1. Check for merge conflicts
2. Check for uncommitted changes
3. Stage all files (`git add -A`)
4. Analyze the staged diff
5. Generate a Conventional Commits message via LLM
6. Present the message for confirmation
7. Execute the commit

### Inline commit message

```
/commit fix typo in header
```

Skips AI generation and commits directly with the provided message.

### Configuration

Create `.pi-git/config.toml` in your project root to set the commit body language:

```toml
# .pi-git/config.toml
lang = "ja"   # Body in Japanese (default: "en" — English)
```

## Commit Message Convention

Generated messages follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:

```
type(scope): subject

body

footer
```

### Types

| Type       | Description                                         |
|------------|-----------------------------------------------------|
| `feat`     | New feature, command, option, or API                |
| `fix`      | Bug fix or correction of unintended behavior        |
| `refactor` | Code structure improvement without behavior change  |
| `chore`    | Build config, dependencies, CI, repository setup    |
| `docs`     | Documentation-only changes                          |
| `test`     | Adding or modifying tests                           |
| `style`    | Code formatting (no behavioral impact)              |
| `perf`     | Performance improvements                            |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test
```

## Requirements

- [pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) (peer dependency)
- [pi-ai](https://github.com/earendil-works/pi-ai) (peer dependency)
- [pi-tui](https://github.com/earendil-works/pi-tui) (optional peer dependency – enables interactive confirmation UI)

## License

MIT © Yoshiki Kudo
