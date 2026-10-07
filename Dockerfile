# All-in-one: tmux or herdr + termote (serve mode, streams the terminal itself)
# Debian, not Alpine: entrypoint.sh needs bash and locales. Pinned by digest.
FROM debian:stable-slim@sha256:5bc3287b25407c965a30f38e32603dc253a3869e1b12a21ac09bfc27fd8b13ce

# Install tools + locale support; tini reaps the tmux processes that daemonize
RUN apt-get update && apt-get install -y --no-install-recommends \
    tini tmux nano vim curl ca-certificates git htop openssl locales \
    && sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# Bash config
RUN echo 'alias ll="ls -la"' >> /etc/bash.bashrc && \
    echo 'alias la="ls -A"' >> /etc/bash.bashrc && \
    echo 'alias l="ls -CF"' >> /etc/bash.bashrc && \
    echo 'export PS1="\[\e[32m\]termote\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ "' >> /etc/bash.bashrc

# tmux config (vi mode for copy: Space=select, Enter=copy, Ctrl+b ]=paste)
RUN echo "set-option -g default-shell /bin/bash" > /etc/tmux.conf && \
    echo "set-option -g default-command /bin/bash" >> /etc/tmux.conf && \
    echo "set-option -g mode-keys vi" >> /etc/tmux.conf && \
    echo "set-option -g mouse on" >> /etc/tmux.conf && \
    echo "bind m set -g mouse \\; display 'Mouse #{?mouse,on,off}'" >> /etc/tmux.conf

# Make passwd/group writable for entrypoint (locked to 644 after writes)
RUN chmod 644 /etc/passwd /etc/group

# Create directories. The container runs as the host uid, which cannot create
# dirs in the root-owned home: .cache, .config and .local/state are open to it
# (sticky, like /tmp) for termote's upload dir, the generated password's file
# and the Web Push key, which it then creates 0700 for itself, so the password
# never goes to the log.
RUN mkdir -p /home/termote/.local/share/nano /home/termote/.local/state /home/termote/.cache /home/termote/.config && \
    chmod -R 755 /home/termote && \
    chmod 1777 /home/termote/.cache /home/termote/.config /home/termote/.local/state

# herdr, the other terminal backend (TERMOTE_MUX=herdr). Pinned with the
# checksum of each arch: termote speaks herdr's protocol of this release.
# A builder without BuildKit leaves TARGETARCH empty; the image's own arch
# picks the binary then.
ARG TARGETARCH
ARG HERDR_VERSION=0.9.1
ARG HERDR_SHA256_AMD64=2a02fed16beb651ef006e1d43f048f652ca4dc58ad053cd2d44450563d5c54b7
ARG HERDR_SHA256_ARM64=f4ccf4de745f2cb9a39a983e9ba3703dad50ec2a58dea83026ceab721bbd8d9e
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    case "$arch" in \
      amd64) t=x86_64;  sum=$HERDR_SHA256_AMD64 ;; \
      arm64) t=aarch64; sum=$HERDR_SHA256_ARM64 ;; \
      *) echo "herdr: unsupported arch $arch" >&2; exit 1 ;; \
    esac && \
    curl -fsSL --retry 3 -o /tmp/herdr "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-$t" && \
    echo "$sum  /tmp/herdr" | sha256sum -c - && \
    install -m 755 /tmp/herdr /usr/local/bin/herdr && rm -f /tmp/herdr && \
    herdr --version

# The termote binary, built with the PWA embedded, for the image's arch:
# server/termote-linux-<arch> (`container up --build` in a checkout, CI, release)
COPY server/termote-linux-* /tmp/
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}" && \
    test -f "/tmp/termote-linux-$arch" || { echo "server/termote-linux-$arch missing" >&2; exit 1; } && \
    install -m 755 "/tmp/termote-linux-$arch" /usr/local/bin/termote && \
    rm -f /tmp/termote-linux-*

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV SHELL=/bin/bash
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
EXPOSE 7680

# -s: also works as a subreaper when the runtime adds its own init (--init)
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/entrypoint.sh"]
