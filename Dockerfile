FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

# The emulator has no dependencies, so npm only brings its own vulnerabilities.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app
COPY package.json LICENSE ./
COPY bin ./bin
COPY src ./src

# Under the MERAKI_EMULATOR_ names, which PORT and HOST take precedence over, so -e with either name overrides them.
ENV MERAKI_EMULATOR_HOST=0.0.0.0 MERAKI_EMULATOR_PORT=8765
USER node
EXPOSE 8765
# Checks every second while starting, so Compose's service_healthy doesn't wait out a whole interval.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --start-interval=1s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||process.env.MERAKI_EMULATOR_PORT)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["node", "bin/meraki-api-emulator.js"]
