Run the published image:

```sh
docker run --rm -p 8765:8765 ghcr.io/dubsector/meraki-api-emulator:0.3
```

The image listens on all interfaces inside the container, and `-p 8765:8765` publishes it on every interface of your machine too. Use `-p 127.0.0.1:8765:8765` to keep it local. Options go after the image name or in environment variables, the same as on the command line (see [Options](https://github.com/dubsector/meraki-api-emulator#options) in the README):

```sh
docker run --rm -p 8765:8765 -e MERAKI_EMULATOR_NOW=2026-01-15T09:00:00Z \
  ghcr.io/dubsector/meraki-api-emulator:0.3 --fault-rate 0.05
```

For another port, change the host side: `-p 9000:8765`. If the port inside the container has to change too, set `PORT` rather than passing `--port`, since the image's health check reads the port from the environment.

Tags follow the release version: `0.3.1` for an exact release, `0.3` for the latest patch of it, and `latest`. While the version starts with `0.`, a new minor version can change responses, so pin `0.3` or an exact version in tests. To build the image yourself, run `docker build -t meraki-api-emulator .` in a clone.

The image leaves out npm and npx, which the emulator doesn't need. CI scans each build with [Trivy](https://trivy.dev) and fails on high or critical vulnerabilities that have a fix, and the published image is rescanned weekly, with findings under the repository's Security tab.

## Docker Compose

Next to an app under test, give the emulator a `meraki.com` name as a network alias. The app can then use it as its base URL, and that also works for the [official Python SDK](Pointing-a-client-at-it#the-official-python-sdk) without a proxy:

```yaml
services:
  meraki:
    image: ghcr.io/dubsector/meraki-api-emulator:0.3
    environment:
      MERAKI_EMULATOR_NOW: 2026-01-15T09:00:00Z
    networks:
      default:
        aliases: [emulator.meraki.com]
  app:
    build: .
    environment:
      MERAKI_BASE_URL: http://emulator.meraki.com:8765/api/v1
      MERAKI_DASHBOARD_API_KEY: any-key
    depends_on:
      meraki:
        condition: service_healthy
```

`MERAKI_BASE_URL` stands for whatever setting your app reads its base URL from. The emulator's `Link` headers keep the name and port the app called, so paging stays on the alias.
