# All-in-one: nginx + ttyd + tmux + tmux-api
FROM tsl0922/ttyd:latest

USER root

# Install nginx and tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    nginx tmux nano vim curl git htop \
    && rm -rf /var/lib/apt/lists/*

# Bash config
RUN echo 'alias ll="ls -la"' >> /etc/bash.bashrc && \
    echo 'alias la="ls -A"' >> /etc/bash.bashrc && \
    echo 'alias l="ls -CF"' >> /etc/bash.bashrc && \
    echo 'export PS1="\[\e[32m\]termote\[\e[0m\]:\[\e[34m\]\w\[\e[0m\]\$ "' >> /etc/bash.bashrc

# tmux config
RUN echo "set-option -g default-shell /bin/bash" > /etc/tmux.conf && \
    echo "set-option -g default-command /bin/bash" >> /etc/tmux.conf

# Make passwd/group writable for entrypoint
RUN chmod 666 /etc/passwd /etc/group

# Create directories
RUN mkdir -p /home/termote/.local/share/nano && chmod -R 777 /home/termote
RUN mkdir -p /var/www/termote

# Fix nginx permissions for non-root user
RUN mkdir -p /var/lib/nginx/body /var/lib/nginx/proxy /var/lib/nginx/fastcgi \
             /var/lib/nginx/uwsgi /var/lib/nginx/scgi \
             /var/log/nginx /var/run && \
    chmod -R 777 /var/lib/nginx /var/log/nginx /var/run

# Copy nginx config
COPY nginx/nginx-docker.conf /etc/nginx/nginx.conf

# Copy PWA files
COPY pwa/dist /var/www/termote

# Copy htpasswd (create if not exists)
COPY .htpasswd /etc/nginx/.htpasswd

# Copy tmux-api binary
COPY tmux-api/tmux-api /usr/local/bin/tmux-api
RUN chmod +x /usr/local/bin/tmux-api

# Copy entrypoint
COPY entrypoint-allinone.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV SHELL=/bin/bash
EXPOSE 8080

ENTRYPOINT ["/entrypoint.sh"]
