FROM nginx:1.27-alpine

ENV UPLOAD_GATEWAY_LIMIT_MB=2048
ENV NGINX_ROLE=business

COPY packages/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates-src/business.conf.template
COPY deploy/nginx-admin.conf /etc/nginx/templates-src/admin.conf.template
COPY deploy/dockerfiles/web-entrypoint.sh /docker-entrypoint.d/40-select-nginx-role.sh
RUN chmod +x /docker-entrypoint.d/40-select-nginx-role.sh

EXPOSE 80
