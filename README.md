# Dark Alley Collab

Dark Alley is a research project and collab is the collaboration backend of it.
It's implemented as a Cloudflare Worker using a Durable Object.

## Developing locally
### Run
To run da-collab locally da-admin also needs to be run locally. This is because da-collab uses a service binding
to communicate with da-admin. When run locally the service binding will be local as well.

To run da-admin locally see https://github.com/adobe/da-admin/blob/main/README.md

1. Clone this repo to your computer.
1. Run `npm install`
1. In a terminal, run `npm run dev` this repo's folder.
1. The da-collab service API is available via http://localhost:4711

#### Access via da-live

To access the locally running da-collab via da-live also running locally, first run da-live on your local machine
in addition to da-collab and da-admin. See here for instructions: https://github.com/adobe/da-live/blob/main/README.md

Then open a browser and access: http://localhost:3000/?da-admin=local&da-collab=local

### Run on stage
You can deploy da-collab on Cloudflare stage via `npm deploy:stage` to test it in a real worker environment. Don't
forget to deploy da-admin on stage as well, as otherwise you might be connecting to an old version.

To access da-collab and da-admin running on stage, open this URL in a browser: http://localhost:3000/?da-admin=stage&da-collab=stage

#### Notes
1. When passing in `?da-collab=local&da-collab=local` each service will set a localStorage value and will not clear until you use `?name-of-service=reset`. It is recommended to use an incognito browser window to ensure you don't forget about this setting.

## Additional details
### Recommendations
1. We recommend running `npm run lint` for linting.
