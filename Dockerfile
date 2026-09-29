FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src

ENV HOST=0.0.0.0 PORT=8765
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8765)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/meraki-api-sandbox.js"]
