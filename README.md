# Shopify App for a custom Printify integration

This is a Node.js application that automates the process of sending orders from Shopify to Printify and then uploading the tracking info to Shopify when the order is fulfilled. A Postgres database is used along with scheduled crons and email notifications are sent to the store owner. The client had specific needs for how the orders should be processed that weren't possible with Printify's own Shopify integration. It also provides a password protected endpoint for the customer to view the database as html.

## Features

- Syncs Shopify orders to a PostgreSQL database.
- Sends orders from the database to Printify after a user-defined delay where they are able to edit shipping details etc. on Shopify.
- Fetches tracking info from Printify and uploads it to the order on Shopify.
- Provides a user interface for viewing orders.
- Email notifications are sent to the store owner if there are any issues.

## How it Works

The application is initiated by a GET request to the `/syncShopifyOrdersToDB` endpoint. This request fetches orders from Shopify and syncs them to a PostgreSQL database. The orders are processed and any necessary notifications are sent via email using SendGrid.

The application also provides a GET request to the `/viewOrders` endpoint, which returns a user interface for viewing orders. The orders are fetched from the database and displayed in a table format.

Cron jobs are set up in the `cronJobs.js` file and are initiated when the server starts. These cron jobs perform various tasks such as syncing the database with Shopify, sending orders to Printify, deleting old orders, getting tracking info, and posting tracking info to Shopify.

## Running the App

The application is started by running the `server.js` file, which sets up the server and starts listening on a specified port. The server setup includes setting up the database and initiating the cron jobs.

## Dependencies

The application uses the following dependencies:

- express: For setting up the server and handling HTTP requests.
- axios: For making HTTP requests to the Shopify and Printify APIs.
- dotenv: For managing environment variables.
- pg-promise: For interacting with the PostgreSQL database.
- node-cron: For scheduling cron jobs.
- @sendgrid/mail: For sending email notifications.

## Note

API keys and other sensitive information are stored in a `.env` file which is ignored by Git. This includes keys for Shopify, Printify, and SendGrid, as well as the database connection string.