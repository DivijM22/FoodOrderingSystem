# API gateway image: nginx with the routing config baked in (works identically on ECS).
FROM nginx:1.29-alpine
COPY nginx.conf /etc/nginx/nginx.conf
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/health > /dev/null || exit 1
