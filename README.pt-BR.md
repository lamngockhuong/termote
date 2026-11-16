<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/branding/termote/social/banner-readme-dark.svg" />
    <img src="assets/branding/termote/social/banner-readme-light.svg" alt="Termote" width="600" />
  </picture>
</p>

<p align="center">
  <a href="https://github.com/lamngockhuong/termote/releases"><img src="https://img.shields.io/github/v/release/lamngockhuong/termote?style=flat-square&color=blue" alt="Release" /></a>
  <a href="https://github.com/lamngockhuong/termote/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/lamngockhuong/termote/ci.yml?branch=main&style=flat-square&label=CI" alt="CI" /></a>
  <a href="https://github.com/lamngockhuong/termote/blob/main/LICENSE"><img src="https://img.shields.io/github/license/lamngockhuong/termote?style=flat-square" alt="License" /></a>
  <a href="https://github.com/lamngockhuong/termote/stargazers"><img src="https://img.shields.io/github/stars/lamngockhuong/termote?style=flat-square&logo=github" alt="GitHub stars" /></a>
  <a href="https://ghcr.io/lamngockhuong/termote"><img src="https://img.shields.io/badge/GHCR-termote-blue?style=flat-square&logo=github" alt="GHCR" /></a>
  <a href="https://hub.docker.com/r/lamngockhuong/termote"><img src="https://img.shields.io/docker/pulls/lamngockhuong/termote?style=flat-square&logo=docker" alt="Docker Pulls" /></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-7.0-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/PWA-ready-5A0FC8?style=flat-square&logo=pwa&logoColor=white" alt="PWA" />
</p>

<p align="center">
  <a href="https://launch.j2team.dev/products/termote?utm_source=badge-launched&utm_medium=badge&utm_campaign=badge-termote" target="_blank" rel="noopener noreferrer"><img src="https://launch.j2team.dev/badge/termote/dark" alt="Termote - Launched on J2TEAM Launch" width="170" height="36" loading="lazy" /></a>
  &nbsp;
  <a href="https://unikorn.vn/p/termote?ref=embed-termote" target="_blank"><img src="https://unikorn.vn/api/widgets/badge/termote?theme=dark" alt="Termote trên Unikorn.vn" width="170" height="42" /></a>
</p>

Controle remotamente ferramentas CLI (Claude Code, Codex, OpenCode, qualquer terminal) de dispositivos moveis/desktop via PWA.

> [!NOTE]
> O Termote 1.0 nao atualiza uma instalacao 0.x. Desinstale o 0.x conforme a
> [documentacao arquivada do 0.x](https://termote.ohnice.app/0.x/) e depois instale o 1.0 com
> os comandos do [Inicio Rapido](#inicio-rapido).

> **Termote** = Terminal + Remote
>
> 🇬🇧 [English](README.md) | 🇻🇳 [Tiếng Việt](README.vi.md) | 🇨🇳 [简体中文](README.zh-CN.md) | 🇯🇵 [日本語](README.ja.md) | 🇰🇷 [한국어](README.ko.md) | 🇪🇸 [Español](README.es.md) | 🇫🇷 [Français](README.fr.md) | 🇩🇪 [Deutsch](README.de.md) | 🇷🇺 [Русский](README.ru.md) | 🇮🇩 [Bahasa Indonesia](README.id.md)

<p align="center">
  <a href="https://termote.ohnice.app/#see-it-in-a-minute"><img src="website/public/video/termote-intro.jpg" alt="Veja o Termote em um minuto (vídeo)" width="720" /></a>
</p>

## Funcionalidades

- **Alternancia de sessions**: Multiplas tmux sessions com criar/editar/excluir
- **Abas de sessions**: Barra de abas horizontal para troca rapida entre janelas
- **Backend Herdr** (nativo ou no contêiner): controle workspaces do Herdr em vez do tmux, com selos de status do agente de codigo em cada painel — veja [Instalacao nativa](https://termote.ohnice.app/installation/native/)
- **Visualizacao Chat**: leia e responda como um chat a um painel que executa Claude Code, Codex (iniciado com `--no-daemon`) ou OpenCode 2, com sugestoes de comandos slash, respostas a dialogos e subagentes em execucao — veja [Agent Chat](https://termote.ohnice.app/usage/agent-chat/)
- **Historico de sessoes**: liste as sessoes do Claude Code, Codex e OpenCode que rodaram na pasta de um painel, leia uma delas, retome-a em uma nova aba ou faca um fork de uma que esteja em execucao — veja [Resuming an Old Session](https://termote.ohnice.app/usage/agent-chat/#resuming-an-old-session)
- **Tokens e custo**: os tokens e o custo estimado de cada sessao de agente, com totais diarios — veja [Tokens and cost](https://termote.ohnice.app/usage/overview/#tokens-and-cost)
- **Arquivos alterados por uma sessao**: os arquivos que uma sessao de agente editou, listados no Changes e no historico de sessoes, cada um abrindo seu diff — veja [Changes](https://termote.ohnice.app/usage/changes/#files-a-session-changed)
- **Visualizacoes Files e Changes**: navegue pelo diretorio de um painel e suas alteracoes no git, com pre-visualizacao de Markdown, em todos os backends, inclusive o psmux no Windows — veja [Files and Changes](https://termote.ohnice.app/usage/files/)
- **Fila de mensagens e links de arquivos no Chat**: deixe uma mensagem na fila enquanto o agente trabalha; toque em um caminho de arquivo escrito pelo agente para abri-lo no Files, na sua linha
- **Revisao e staging**: comente linhas no Changes e no Files e envie a revisao a um agente; faca stage, unstage ou descarte uma alteracao por arquivo ou por hunk
- **Pre-visualizacao e edicao no Files**: PDF, .xlsx e .docx somente leitura; abra e salve arquivos Shift-JIS, EUC-JP e UTF-16; edite Markdown ao lado de uma pre-visualizacao ao vivo
- **Abrir no Windows** (WSL): copie o caminho Windows de um arquivo, ou abra um arquivo ou pasta com o programa do Windows, quando o servidor roda no WSL
- **Places**: ofereca no Files uma pasta fora do painel com `termote start --allow-path <dir>` — veja [Places](https://termote.ohnice.app/usage/files/#places)
- **Tasks**: execute os scripts do `package.json` e os targets do Makefile de um painel, envie uma execucao com falha a um agente — veja [Tasks](https://termote.ohnice.app/usage/tasks/)
- **Worktrees**: abra um git worktree como um grupo proprio, a partir de um branch novo ou existente (Herdr, tmux, Zellij, herdr-core, psmux) — veja [Worktrees](https://termote.ohnice.app/usage/sessions/#worktrees)
- **Janelas proprias** (desktop): abra um arquivo, diff, aba, painel ou a visao geral em sua propria janela
- **Anexos de imagem**: envie uma imagem do celular para o terminal ou para uma mensagem da visualizacao Chat, para que o agente a leia pelo caminho; uma imagem colada no Claude Code, Codex ou OpenCode abre de novo pela visualizacao Chat
- **Backend Zellij** (Linux, macOS ou no container): controle suas sessoes, abas e paineis do Zellij em vez do tmux (Zellij 0.45.0 ou posterior), escolhido com `--mux zellij` — veja [Instalacao nativa](https://termote.ohnice.app/installation/native/)
- **Backend herdr-core** (nativo, qualquer SO): mostra os espacos, abas e paineis que o app herdr mostra, como mais um cliente do herdr-core (`hc` 0.1.16 ou posterior), escolhido com `--mux hc` — veja [Backend herdr-core](https://termote.ohnice.app/installation/native/#herdr-core-backend)
- **Machines**: acompanhe e controle os agentes dos seus outros computadores a partir de um unico Termote, via SSH com uma chave que so alcanca o Termote de la (`termote machine add <alias>`) — veja [Machines](https://termote.ohnice.app/usage/machines/)
- **Plugin do Herdr**: abra no Termote o painel do Herdr em foco, mostre o link dele como QR code para o celular e inicie ou pare o servidor, sem sair do Herdr — veja [Herdr Plugin](https://termote.ohnice.app/usage/herdr-plugin/)
- **Otimizado para mobile**: Barra de teclado virtual (Tab/Ctrl/Shift/setas, expansivel)
- **Suporte a gestos**: Deslizar para Ctrl+C, Tab, rolagem
- **Historico de comandos**: Recuperar comandos enviados anteriormente com busca
- **Acoes rapidas**: A tecla ⋯ fixada no fim da barra mobile mostra uma linha Actions com operacoes comuns (clear, cancel, exit)
- **Estilos de interface**: Neutral, Terminal ou Native, escolhidos nas Configuracoes, independentes do tema claro/escuro
- **Idioma da interface**: inglês ou vietnamita, escolhido nas Configuracoes; Auto segue o navegador
- **Configuracoes portateis**: exporte as configuracoes deste navegador para um arquivo e importe-as em outro, ou revise as configuracoes que um agente de codigo propoe com `termote settings propose` — veja [Settings](https://termote.ohnice.app/usage/settings/#export-and-import)
- **Terminal na GPU**: o terminal e desenhado com WebGL2 quando o dispositivo tem GPU, o que mantem fluidas as saidas grandes
- **Indicador de conexao**: Status do servidor em tempo real com deteccao automatica de desconexao
- **Verificador de atualizacao**: Notificacao automatica de nova versao do GitHub releases
- **PWA**: Instalavel na tela inicial, funciona offline
- **Sessions persistentes**: tmux mantem as sessions ativas
- **Barra lateral recolhivel**: Interface desktop com barra lateral de sessions alternavel
- **Modo tela cheia**: Experiencia imersiva de terminal
- **Roda como servico**: `termote start` registra um servico do usuario (systemd, launchd, Tarefa Agendada) que inicia no login
- **Persistencia de configuracao**: `termote start` salva suas opcoes, com a senha armazenada criptografada

## Capturas de Tela

**[Experimente a demo](https://termote.ohnice.app/demo/)**: o app real no seu navegador, no celular ou no desktop, com dados ficticios e sem instalar nada.

<p align="center">
  <img src="docs/images/screenshots/phones.png" alt="Terminal, Chat e Changes no celular" width="720" />
</p>

<p align="center">
  <img src="docs/images/screenshots/desktop.png" alt="Desktop: Chat and Changes on Herdr" width="720" />
</p>

<p align="center">
  <img src="docs/images/screenshots/ui-styles.png" alt="Os estilos de interface Neutral, Terminal e Native, no claro e no escuro" width="720" />
</p>

## Arquitetura

```mermaid
flowchart TB
    subgraph Client["Cliente (Mobile/Desktop)"]
        PWA["PWA - React + xterm.js"]
        Gestures["Controles por Gestos"]
        Keyboard["Teclado Virtual"]
    end

    subgraph Server["termote Server :7680"]
        Static["Static Files"]
        Stream["WebSocket do terminal /api/mux/stream"]
        API["REST API /api/mux/*"]
        Guard["Lista de hosts permitidos + protecao Origin/CSRF"]
        Auth["Basic Auth"]
    end

    subgraph Backend["Backend Mux (tmux/psmux, Herdr, Zellij ou herdr-core)"]
        Mux["Interface Mux"]
        tmux["tmux/psmux (PTY)"]
        herdr["Herdr"]
        zellij["Zellij"]
        hc["herdr-core (hc)"]
        Shell["Shell"]
        Tools["CLI Tools"]
    end

    Gestures --> PWA
    Keyboard --> PWA
    PWA --> Static
    PWA <--> Stream
    PWA --> API
    Guard -.-> Static & Stream & API
    Auth -.-> Static & Stream & API
    Stream --> Mux
    API --> Mux
    Mux --> tmux & herdr & zellij & hc
    tmux --> Shell --> Tools
```

O termote transmite o proprio terminal (PTY no Unix, ConPTY no Windows) para o xterm.js na PWA; nao existe mais um processo de terminal separado para fazer proxy. O modelo completo de protecao de requisicoes esta em [`docs/system-architecture.md`](docs/system-architecture.md).

## Inicio Rapido

> 📖 **Novo no Termote?** Confira o [Guia de Inicio](docs/getting-started.md) para um passo a passo completo com exemplos.

**Linux / macOS:**

```bash
curl -fsSL https://termote.ohnice.app/install.sh | sh
termote start
```

**Homebrew (macOS, Linux):**

```bash
brew install lamngockhuong/tap/termote
termote start
```

Uma instalação pelo Homebrew é atualizada pelo brew, não por `termote update`: `brew upgrade termote && termote restart`. Para remover: `termote uninstall && brew uninstall termote`.

**Windows (PowerShell):**

```powershell
irm https://termote.ohnice.app/install.ps1 | iex
termote start
```

**Com um agente de programação:** cole o prompt de [Install with an agent](https://termote.ohnice.app/installation/agent/) no Claude Code, Codex ou outro agente. Ele segue [`agents.md`](https://termote.ohnice.app/agents.md), verifica se o servidor responde e deixa a senha com você.

O instalador precisa apenas de `curl`, `tar` e `sha256sum`/`shasum` (PowerShell no Windows), sem sudo nem permissao de administrador. Ele verifica o checksum do arquivo, instala o comando `termote` e nao inicia nada. `termote start` salva as opcoes, cria uma senha na primeira vez (exibida uma unica vez, e so em um terminal; `termote show-password` mostra de novo), registra o servico e o inicia. Abra `http://127.0.0.1:7680` (Windows: `http://127.0.0.1:7690`).

Um backend de terminal precisa estar instalado antes: tmux (`sudo apt install tmux`, `brew install tmux`), psmux no Windows (`winget install psmux`) ou [Herdr](https://termote.ohnice.app/installation/native/). O primeiro `start` detecta qual usar. [Zellij](https://zellij.dev/documentation/installation) 0.45.0 ou posterior (Linux, macOS) nunca e detectado: escolha com `--mux zellij`. [herdr-core](https://herdr.dev/core/) (`hc` 0.1.16 ou posterior, qualquer SO, so nativo) tambem nunca e detectado: escolha com `--mux hc`.

### Opcoes comuns

```bash
termote start --lan                  # Listen on the LAN, not only this machine
termote start --tailscale myhost.ts.net  # Publish over Tailscale HTTPS
termote start --mux herdr            # Drive Herdr workspaces instead of tmux
termote start --mux zellij           # Drive Zellij sessions instead of tmux (Linux, macOS)
termote start --mux hc               # Show the herdr app's terminals through herdr-core
termote start --no-auth              # Disable basic auth (local use only)
```

As opcoes ficam salvas: uma flag nao informada mantem o valor salvo, e uma opcao booleana e desligada com `=false` (`termote start --lan=false`). As flags sao as mesmas em todos os sistemas, inclusive no PowerShell.

### Comandos do dia a dia

```bash
termote status                       # What the running server reports
termote stop                         # Stop (it starts again at the next login)
termote restart                      # Restart with the saved options
termote logs follow                  # Tail the logs
termote show-password                # Print the saved username and password
termote url --qr                     # The link to open, as a QR code for a phone
termote pair                         # A one-time code that signs a new device in
termote devices                      # List the paired devices (devices revoke <id>)
termote machine add <ssh alias>      # Reach another computer's Termote (Machines in the sidebar)
termote update                       # Update to the latest release
termote uninstall                    # Remove the service, the command, the install and uploads
```

`update` troca para a nova versao, reinicia o servico e volta para a anterior se a nova versao nao subir. `uninstall` mantem a configuracao (`~/.config/termote`) e os logs (`~/.local/state/termote`) e exibe os dois caminhos; `uninstall --purge` remove os dois tambem.

## Instalacao

### Fixar uma versao

```bash
curl -fsSL https://termote.ohnice.app/install.sh | TERMOTE_VERSION=1.0.0 sh
termote update --version 1.0.0
```

```powershell
$env:TERMOTE_VERSION='1.0.0'; irm https://termote.ohnice.app/install.ps1 | iex
```

Sem `TERMOTE_VERSION`, o instalador usa a release estavel mais recente (1.0 ou posterior) e nao mexe em uma instalacao existente. Com ela, essa versao e instalada ao lado da atual e passa a ser a versao ativa, o que tambem repara uma instalacao quebrada. Uma pre-release (`X.Y.Z-rc.N`) so e instalada quando nomeada assim (ou com `termote update --version`), e so depois de publicada; veja o [Deployment Guide](docs/deployment-guide.md#pre-releases).

### Modo Container

```bash
termote container up                          # Run the published image (podman or docker)
termote container up --workspace ~/projects   # Mount a directory at /workspace
termote container status
termote container logs -f
termote container down
```

`container up` executa `ghcr.io/lamngockhuong/termote` na versao do `termote` instalado, com podman (preferido) ou docker, na porta 7680, com `~/termote-workspace` montado em `/workspace`. Ele aceita `--port`, `--lan`, `--tailscale`, `--cloudflare`, `--no-auth`, `--mux`, `--allow-host`, `--allow-path`, `--user`, `--fresh`, `--workspace` e `--build` (so em um checkout), salvos separadamente das opcoes de `start`; o usuario e a senha sao compartilhados com o servidor nativo. O Docker reinicia o container apos um reboot; o Podman rootless nao tem daemon para isso, entao execute-o como uma unidade Quadlet.

> **Nota de seguranca**: Evite montar `$HOME` diretamente — diretorios sensiveis como `.ssh`, `.gnupg` ficarao acessiveis no container. Monte apenas diretorios de projeto especificos.

### Docker sem a CLI

```bash
# Generates a password: docker exec termote cat /home/termote/.config/termote/password
docker run -d --name termote -p 7680:7680 \
  -v ~/projects:/workspace \
  ghcr.io/lamngockhuong/termote:latest

# With your own credentials
docker run -d --name termote -p 7680:7680 \
  -e TERMOTE_USER=admin -e TERMOTE_PASS=secret \
  ghcr.io/lamngockhuong/termote:latest
```

| Variavel de Ambiente | Descricao                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TERMOTE_USER`       | Usuario da autenticacao basica (padrao: `admin`)                                                                 |
| `TERMOTE_PASS`       | Senha da autenticacao basica (padrao: gerada automaticamente, salva em `/home/termote/.config/termote/password`) |
| `NO_AUTH`            | Defina como `true` para desativar a autenticacao                                                                 |

### Compilar a partir do codigo fonte

```bash
git clone https://github.com/lamngockhuong/termote.git
cd termote
make build
./scripts/termote.sh start
```

`make build` compila o PWA e o embute em `server/termote`; requer Go, Node.js e pnpm. `scripts/termote.sh` (Windows: `scripts\termote.ps1`) so executa um checkout: recompila o binario de desenvolvimento quando algum fonte e mais novo e o executa com os mesmos argumentos. `termote update` se recusa a rodar em um checkout; use `git pull && make build`.

### Atualizando a partir do 0.x

Nao ha atualizacao a partir do 0.x: o 1.0 e instalado em outro local e nao le a configuracao do 0.x. Desinstale o 0.x conforme a [documentacao arquivada do 0.x](https://termote.ohnice.app/0.x/) e depois instale o 1.0 com os comandos acima.

## Modos de Implantacao

```mermaid
flowchart LR
    subgraph Container["Modo Container"]
        direction TB
        C1["Docker/Podman"] --> C2["termote :7680 (transmite o terminal por conta propria)"] --> C3["tmux / Herdr / Zellij"]
    end

    subgraph Native["Modo Nativo"]
        direction TB
        N1["Sistema Host"] --> N2["termote :7680 (transmite o terminal por conta propria)"] --> N3["tmux/psmux, Herdr, Zellij ou herdr-core + Ferramentas do Host"]
    end

    User["Usuario"] --> Container & Native
```

| Modo      | Comando                | Caso de Uso                               | Plataforma            |
| --------- | ---------------------- | ----------------------------------------- | --------------------- |
| Nativo    | `termote start`        | Acesso a ferramentas do host (claude, gh) | macOS, Linux, Windows |
| Container | `termote container up` | Ambiente isolado                          | macOS, Linux, Windows |

O servidor nativo roda como servico do usuario: uma unidade systemd de usuario no Linux (um processo desanexado quando nao ha systemd de usuario, como no WSL2 sem systemd), um agente launchd no macOS e uma Tarefa Agendada no logon no Windows.

### Opcoes de `start`

| Flag                              | Descricao                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `--port <port>`                   | Porta (padrao: 7680, Windows: 7690)                                                                               |
| `--lan[=false]`                   | Escutar em todas as interfaces (padrao: apenas localhost)                                                         |
| `--tailscale <host[:port]>`       | Publicar via Tailscale HTTPS (porta padrao 443)                                                                   |
| `--no-tailscale`                  | Parar de publicar via Tailscale                                                                                   |
| `--cloudflare <host>`             | Nome de host de um Cloudflare Tunnel que voce executa; avisa quando o Cloudflare Access nao esta na frente dele   |
| `--no-cloudflare`                 | Esquecer o nome de host do Cloudflare                                                                             |
| `--proxy-client-header <name>`    | Cabecalho em que um proxy coloca o endereco do cliente (padrao com `--cloudflare`: `CF-Connecting-IP`)            |
| `--no-proxy-client-header`        | Parar de le-lo                                                                                                    |
| `--no-auth[=false]`               | Desativar a autenticacao basica                                                                                   |
| `--mux <tmux\|herdr\|zellij\|hc>` | Backend do terminal (padrao: herdr quando estiver rodando, senao tmux; zellij: Linux, macOS; hc: herdr-core)      |
| `--allow-host <name>`             | Permitir um valor extra no cabecalho Host (repetivel; sem curinga, veja as notas de seguranca)                    |
| `--remove-host <name>`            | Remover um nome de Host permitido (repetivel)                                                                     |
| `--allow-local-user <name>`       | Permitir que outro usuario do sistema nesta maquina se conecte, ex.: um proxy reverso (repetivel; Linux, Windows) |
| `--remove-local-user <name>`      | Deixar de permitir a conexao desse usuario (repetivel)                                                            |
| `--allow-path <dir>`              | Oferecer uma pasta no Files, em Places (repetivel)                                                                |
| `--remove-path <dir>`             | Remover uma pasta permitida (repetivel)                                                                           |
| `--allow-herdr-no-auth`           | Obrigatorio junto com `--mux herdr --no-auth`                                                                     |
| `--allow-hc-no-auth`              | Obrigatorio junto com `--mux hc --no-auth`                                                                        |
| `--user <name>`                   | Nome de usuario de login (padrao: `admin`; compartilhado com o container)                                         |
| `--fresh`                         | Definir uma nova senha                                                                                            |

### Com Tailscale HTTPS

Usa `tailscale serve` para HTTPS automatico (sem gerenciar certificados manualmente):

```bash
termote start --tailscale myhost.ts.net                # Default port 443
termote start --tailscale myhost.ts.net:8765           # Custom port
termote container up --tailscale myhost.ts.net         # Container mode
sudo tailscale set --operator=$USER                    # Linux, once: let termote run tailscale serve
```

O mapeamento e aplicado toda vez que o servidor inicia. `stop`, `start --no-tailscale` e `uninstall` removem apenas o mapeamento do proprio Termote.

## Suporte a Plataformas

| Plataforma | Container | Nativo | Instalador    |
| ---------- | --------- | ------ | ------------- |
| Linux      | ✓         | ✓      | `install.sh`  |
| macOS      | ✓         | ✓      | `install.sh`  |
| Windows    | ✓         | ✓      | `install.ps1` |

> **Suporte ao Windows**: O modo container requer Docker Desktop ou Podman Desktop; o modo nativo requer o [psmux](https://github.com/psmux/psmux) (multiplexador de terminal compativel com tmux para Windows), instalado com `winget install psmux`, ou um servidor [Herdr](https://herdr.dev/#install) em execucao.

## Uso no Mobile

| Acao                 | Gesto                           |
| -------------------- | ------------------------------- |
| Cancelar/interromper | Deslizar para esquerda (Ctrl+C) |
| Tab completion       | Deslizar para direita           |
| Rolar para baixo     | Deslizar para cima              |
| Rolar para cima      | Deslizar para baixo             |
| Colar                | Pressionar longo                |
| Tamanho da fonte     | Pincar para dentro/fora         |

A barra de ferramentas virtual oferece: Tab, Esc, Ctrl, Shift, teclas de seta e combinacoes de teclas comuns. Suporta combinacoes Ctrl+Shift (colar, copiar). Alterne entre modo minimo e expandido para teclas adicionais (Home, End, Delete, etc.).

## Estrutura do Projeto

```
termote/
├── Makefile                # Build/test/run commands
├── Dockerfile              # Container image (termote + tmux + herdr + zellij)
├── docker-compose.yml      # Development from a checkout only
├── entrypoint.sh           # Container entrypoint
├── docs/                   # Documentation
│   └── images/screenshots/ # App screenshots
├── pwa/                    # React PWA
│   └── src/
│       ├── components/
│       ├── contexts/
│       ├── hooks/
│       ├── types/
│       └── utils/
├── server/                 # Go server + CLI (single binary)
│   ├── main.go             # Entry point (no args = menu, `serve` = server, else CLI)
│   ├── serve.go            # Server (PWA, auth, guards)
│   ├── mux.go              # Mux interface + /api/mux/* routes
│   ├── mux_tmux.go         # tmux/psmux backend
│   ├── mux_herdr.go        # Herdr backend
│   ├── mux_zellij*.go      # Zellij backend (commands, Chat view and Files)
│   ├── zellij_*.go         # Termote's Zellij clients, view-only stream, a pane's shell
│   ├── mux_hc*.go, hc_*.go # herdr-core backend (hc connect client, herdr-app document)
│   ├── stream.go           # Terminal WebSocket (xterm.js stream)
│   ├── agent_*.go          # Chat view, session history, tokens and cost (Claude Code, Codex, OpenCode)
│   ├── cli*.go             # start/stop/update/container/logs/menu subcommands
│   └── webui/              # PWA embedded in the binary (filled by make build)
├── scripts/
│   ├── install.sh          # Unix online installer (curl | sh)
│   ├── install.ps1         # Windows online installer (irm | iex)
│   ├── termote.sh          # Unix shim: builds and runs a checkout
│   └── termote.ps1         # Windows PowerShell shim: builds and runs a checkout
├── tests/                  # Test suite
│   ├── test-termote.sh     # Unix shim tests
│   ├── test-termote.ps1    # Windows shim tests
│   ├── test-install.sh     # Unix installer tests
│   ├── test-install.ps1    # Windows installer tests
│   └── test-entrypoints.sh # Container entrypoint tests
├── herdr-plugin/           # Herdr plugin (open a pane in Termote, QR code, start/stop)
├── video/                  # Remotion intro video
└── website/                # Astro Starlight docs site
    └── src/content/docs/   # MDX documentation
```

## Desenvolvimento

```bash
make build          # Build the PWA and embed it in server/termote
make test           # Run all tests
make health         # Check service health
make clean          # Stop containers

# E2E tests (requires running server)
./scripts/termote.sh start           # Start server first
pnpm --filter termote test:e2e       # Run Playwright tests
pnpm --filter termote test:e2e:ui    # Run with UI debugger
```

**Testes Manuais:** Veja o [Self-Test Checklist](docs/self-test-checklist.md)

## Solucao de Problemas

### Session nao persiste

- Verifique o tmux: `tmux ls`
- O termote se conecta com `tmux new-session -A` (attach-or-create)

### Erros de WebSocket

- Verifique os logs do termote: `termote container logs` (container) ou `termote logs server` (nativo)
- O WebSocket do terminal e `/api/mux/stream`, servido pelo proprio termote — nao ha processo de terminal separado para verificar

### Problemas com teclado no mobile

- Certifique-se de que a meta tag viewport esta presente
- Teste em um dispositivo real, nao em emulador

### Modo nativo: servidor nao inicia

```bash
termote status             # What the running server reports
termote logs server        # Or: termote logs follow
lsof -i :7680              # Check what holds the port
termote start --fresh      # If the saved password can no longer be read
```

## Notas de Seguranca

- **Padrao: apenas localhost** - nao exposto a LAN a menos que a flag `--lan` seja usada
- **Autenticacao basica ativada por padrao** - use `--no-auth` para desativar em desenvolvimento local; a senha e criada pelo primeiro `termote start` e salva criptografada
- **Allowlist de Host**: requisicoes com cabecalho `Host` desconhecido sao rejeitadas (protecao contra DNS rebinding); adicione nomes confiaveis com `--allow-host`, nao ha curinga para desligar a verificacao
- **Protecoes Origin/CSRF**: requisicoes `/api/mux/*` que alteram estado e o WebSocket `/api/mux/stream` rejeitam `Sec-Fetch-Site`/`Origin` de outros sites e exigem um token de stream de uso unico, da mesma origem
- **Protecao integrada contra forca bruta** - limitacao de taxa (5 tentativas falhas/min por IP, 20/min por IPv6 /64)
- **Backend Herdr**: expoe todos os workspaces do Herdr no host, por isso `--mux herdr --no-auth` e recusado a menos que `--allow-herdr-no-auth` tambem seja informado
- **Backend Zellij**: expoe todas as sessoes do Zellij em execucao do usuario, como o tmux (sem protecao `--no-auth` extra); teclas e mensagens do Chat chegam a um painel apenas pelo terminal de um cliente Zellij do Termote, nunca por argumentos de processo que outros usuarios locais poderiam ler
- **Backend herdr-core**: o herdr-core nao tem login proprio, por isso `--mux hc --no-auth` e recusado a menos que `--allow-hc-no-auth` tambem seja informado, e `container up --mux hc` e recusado
- **Arquivos de servico sem segredos**: a unidade systemd, o agente launchd e a Tarefa Agendada nunca contem a senha
- Use HTTPS (Tailscale) em producao
- Restrinja a redes confiaveis/VPN
- O que um dispositivo conectado ou pareado pode fazer, e o que fazer quando um for perdido: [Modelo de seguranca](docs/security-model.md)

## Outros Projetos

| Projeto                                                     | Descricao                                                                                                                                      |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [GitHub Flex](https://github.com/lamngockhuong/github-flex) | Extensao multi-navegador (Chrome e Firefox) que aprimora a interface do GitHub com recursos de produtividade                                   |
| [TabRest](https://github.com/lamngockhuong/tabrest)         | Extensao do Chrome que descarrega automaticamente abas inativas para liberar memoria                                                           |
| [Specpin](https://github.com/lamngockhuong/specpin)         | Fixa especificacoes de negocio vivas e versionadas com Git nos elementos da sua interface web em execucao (extensao de navegador + sidecar Go) |

## Licenca

MIT
