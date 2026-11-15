# Third-party notices

Third-party code, fonts and services that RelayProof uses, and their licenses. Versions are the ones pinned in `bifrost-shadow/site/pnpm-lock.yaml`, `bifrost-shadow/plugins/shadow/go.mod` and `bifrost-shadow/scripts/setup.sh`.

| Component | How it is used | License |
| --- | --- | --- |
| [Bifrost](https://github.com/maximhq/bifrost), commit `ed62e4b` | Downloaded by `bifrost-shadow/scripts/setup.sh`, patched with `bifrost-shadow/patches/` and built into the gateway binary that runs the plugin | Apache-2.0 |
| [google/uuid](https://github.com/google/uuid) 1.6.0 | Compiled into the plugin for record and event IDs | BSD-3-Clause |
| [testify](https://github.com/stretchr/testify) 1.12.1 | The plugin's tests only | MIT |
| [React and React DOM](https://react.dev/) 19.3.1 | Bundled into the site and the console | MIT |
| [Lenis](https://github.com/darkroomengineering/lenis) 1.3.27 | Bundled into the site for smooth scrolling | MIT |
| [Archivo](https://fonts.google.com/specimen/Archivo), from `@fontsource-variable/archivo` 5.3.0 | Font files bundled with the site | SIL Open Font License 1.1 |
| [JetBrains Mono](https://www.jetbrains.com/lp/mono/), from `@fontsource-variable/jetbrains-mono` 5.3.0 | Font files bundled with the site | SIL Open Font License 1.1 |
| [Vite](https://vite.dev/) 8.3.8 and `@vitejs/plugin-react` 6.3.0 | Build tool for the site, not shipped | MIT |
| [TypeScript](https://www.typescriptlang.org/) 7.0.2 | Typechecking for the site and the client, not shipped | Apache-2.0 |
| Anthropic API (Claude models) | Called by the hosted demo backend when `ANTHROPIC_API_KEY` is set | Anthropic's commercial terms |
| Render and Vercel | Host the demo backend and the site | Their service terms |

The Go modules that Bifrost itself depends on are listed in the `go.mod` files of the upstream repository and are covered by their own licenses.
