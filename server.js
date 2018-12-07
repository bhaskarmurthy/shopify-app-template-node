import 'isomorphic-fetch';
import Koa from 'koa';
import next from 'next';
import Router from 'koa-router';
import bodyParser from 'koa-bodyparser';
import {readFileSync} from 'fs-extra';
import createShopifyAuth from '@shopify/koa-shopify-auth';
import dotenv from 'dotenv';
import { verifyRequest } from '@shopify/koa-shopify-auth';
import session from 'koa-session';
import graphQLProxy from '@shopify/koa-shopify-graphql-proxy';
import {port, dev, tunnelFile} from './config/server';
import {processPayment} from './server/router';
import validateWebhook from './server/webhooks';

const app = next({ dev });
const handle = app.getRequestHandler();

dotenv.config();
const { SHOPIFY_API_SECRET_KEY, SHOPIFY_API_KEY } = process.env;

app.prepare().then(() => {
  const server = new Koa();
  const router = new Router();
  server.use(session(server));
  server.keys = [SHOPIFY_API_SECRET_KEY];

  router.post('/webhooks/products/create', validateWebhook);

  router.get('/', processPayment);

  router.get('*', async (ctx) => {
    await handle(ctx.req, ctx.res);
    ctx.respond = false;
  });

  server.use(async (ctx, next) => {
    ctx.res.statusCode = 200;
    await next();
  });

  server.use(
    createShopifyAuth({
      apiKey: SHOPIFY_API_KEY,
      secret: SHOPIFY_API_SECRET_KEY,
      scopes: ['read_products', 'write_products'],
      async afterAuth(ctx) {
        const { shop, accessToken } = ctx.session;

        console.log('We did it!', shop, accessToken);

        const tunnelUrl = readFileSync(tunnelFile).toString();

        const stringifiedBillingParams = JSON.stringify({
          recurring_application_charge: {
            name: 'Recurring charge',
            price: 20.01,
            return_url: tunnelUrl,
            test: true
          }
        })

        const stringifiedWebhookParams = JSON.stringify({
          webhook: {
            topic: 'products/create',
            address: `${tunnelUrl}/webhooks/products/create`,
            format: 'json',
          },
        });

        const webhookOptions = {
          method: 'POST',
          body: stringifiedWebhookParams,
          credentials: 'include',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        };
        await fetch(`https://${shop}/admin/webhooks.json`, webhookOptions)
          .then((response) => response.json())
          .then((jsonData) =>
            console.log('webhook response', JSON.stringify(jsonData)),
          )
          .catch((error) => console.log('webhook error', error));

        const options = {
          method: 'POST',
          body: stringifiedBillingParams,
          credentials: 'include',
          headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json',
          },
        };

        const confirmationURL = await fetch(
          `https://${shop}/admin/recurring_application_charges.json`, options)
          .then((response) => response.json())
          .then((jsonData) => jsonData.recurring_application_charge.confirmation_url)
          .catch((error) => console.log('error', error));

        await ctx.redirect(confirmationURL);
      },
    }),
  );
  server.use(graphQLProxy());
  server.use(bodyParser());
  server.use(router.routes());
  server.use(verifyRequest({authRoute: '/auth'}));

  server.listen(port, () => {
    console.log(`> Ready on http://localhost:${port}`);
  });
});
