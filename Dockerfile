# All-in-one: tmux + tmux-api (serve mode, streams the terminal itself)
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

# Create directories
RUN mkdir -p /home/termote/.local/share/nano && chmod -R 755 /home/termote
RUN mkdir -p /var/www/termote

# Copy PWA files
COPY pwa/dist /var/www/termote

# Copy tmux-api binary (supports both single binary and multi-arch builds)
ARG TARGETARCH
COPY tmux-api/tmux-api* /tmp/
RUN if [ -f "/tmp/tmux-api-linux-${TARGETARCH}" ]; then \
      cp "/tmp/tmux-api-linux-${TARGETARCH}" /usr/local/bin/tmux-api; \
    else \
      cp /tmp/tmux-api /usr/local/bin/tmux-api; \
    fi && \
    chmod +x /usr/local/bin/tmux-api && \
    rm -f /tmp/tmux-api*

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV SHELL=/bin/bash
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
EXPOSE 7680

# -s: also works as a subreaper when the runtime adds its own init (--init)
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/entrypoint.sh"]
