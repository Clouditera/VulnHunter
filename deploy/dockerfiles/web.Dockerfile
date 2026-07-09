FROM nginx:1.27-alpine

ENV UPLOAD_GATEWAY_LIMIT_MB=2048

COPY packages/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template

EXPOSE 80
