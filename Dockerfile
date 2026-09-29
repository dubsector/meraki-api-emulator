FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src

ENV HOST=0.0.0.0 PORT=8765
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/meraki-api-emulator.js"]
