const cron = require("node-cron");
const axios = require("axios");
const sgMail = require("@sendgrid/mail");
sgMail.setApiKey(process.env.SENDGRID_API_KEY);

//Checking for environment - if the code is running on Render then it will have a NODE_ENV of production
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

function cancellation48Hours_CronJob(db) {
  cron.schedule("05 * * * *", function () {
    console.log(
      `@@@ Running cron job to cancel orders that have been in the queue over ${process.env.HOW_LONG_WAIT_BEFORE_REFUNDING} hours`
    );
    db.any(
      `
            SELECT * FROM orders 
            WHERE 
            (order_sent_to_printify IS NULL OR order_sent_to_printify ->> 'sent_to_production' = 'No' OR order_sent_to_printify ->> 'sent_to_production' = 'Error' OR order_sent_to_printify ->> 'id' IS NULL OR order_sent_to_printify ->> 'id' = '')
            AND has_been_cancelled = ''
            AND EXTRACT(EPOCH FROM NOW() - created_at)/3600 > $1
            AND has_printify_items != 'No - (Printful SKUs or No SKUs)'
            AND order_number >= 10154
        `,
      [process.env.HOW_LONG_WAIT_BEFORE_REFUNDING]
    )
      .then((orders) => {
        if (orders.length > 0) {
          const orderNumbers = orders.map((order) => order.order_number);
          console.log(
            `The following order numbers will be expired: ${orderNumbers.join(
              ", "
            )}`
          );

          const emailSubject = `${orderNumbers.join(", ")} - 48 Hours expired`;
          const emailBody = `The above order numbers are no longer eligible for automation, if they need fulfilling you will need to do this manually`;

          // Send the email
          const msg = {
            to: process.env.EMAIL_TO,
            from: process.env.EMAIL_FROM,
            subject: emailSubject,
            text: emailBody,
            html: `<p>${emailBody}</p>`,
          };

          sgMail
            .send(msg)
            .then(() => {
              console.log(
                `Email sent: ${orderNumbers.join(", ")} - 48 Hours expired`
              );
            })
            .catch((error) => {
              console.error(error);
            });

          for (const order of orders) {
            db.none("UPDATE orders SET has_been_cancelled = $1 WHERE id = $2", [
              `${process.env.HOW_LONG_WAIT_BEFORE_REFUNDING} hours expired - no longer eligible for automation`,
              order.id,
            ]).catch((error) =>
              console.error(
                `Error updating order for automated cancallation ${order.order_number}:`,
                error
              )
            );
          }
        } else {
          console.log("No orders have passed 48 hours old");
        }
      })
      .catch((error) =>
        console.error(
          "Error fetching orders for automated cancallation:",
          error
        )
      );
  });
}

function SyncDBWithShopify_CronJob() {
  cron.schedule("14 * * * *", function () {
    console.log("@@@ Running cron job to sync DB with Shopify");
    axios
      .get(`${process.env.APP_URL}/syncShopifyOrdersToDB`)
      .then((response) => console.log("Sync DB to Shopify Cron job completed"))
      .catch((error) =>
        console.error("Sync DB to Shopify Cron job failed:", error)
      );
  });
}

function sendOrdersToPrintify_CronJob(db) {
  //cron.schedule("23 * * * *", function () {
  cron.schedule("39 * * * *", function () {
    console.log(`@@@ Running cron job to send orders to Printify`);

    const ordersSuccessfullySentToPrintify = [];
    const ordersFailedToSendToPrintify = [];
    const ordersFailedToSendToPrintifyNumbers = [];

    // Define the SQL query with the new conditions
    // HOW_LONG_WAIT_BEFORE_REFUNDING <= *rows* >= AUTOMATED_ORDER_DELAY hours old
    // 1. has_been_cancelled equals an empty string
    // 2. order_sent_to_printify equals null
    // 3. shopify_tags does not contain the string "Missing Info" or "Do Not Automate"
    // 4. has_printify_items value MUST BE 'Yes' or 'Partially'
    // 5. required_info_warning must be an empty array
    const sqlQuery = `
            SELECT * FROM orders 
            WHERE 
                (EXTRACT(EPOCH FROM NOW() - created_at)/3600 >= $1 OR shopify_tags LIKE '%Automate now%')
                AND EXTRACT(EPOCH FROM NOW() - created_at)/3600 <= $2 + 1
                AND has_been_cancelled = ''
                AND (order_sent_to_printify IS NULL OR order_sent_to_printify ->> 'message' = 'Action temporarily unavailable, please try again in two hours.')
                AND shopify_tags NOT LIKE '%Missing Info%'
                AND shopify_tags NOT LIKE '%Do Not Automate%'
                AND has_printify_items IN ('Yes', 'Partially')
                AND ARRAY_LENGTH(required_info_warning, 1) IS NULL
                AND order_number >= 10025
        `;

    db.any(sqlQuery, [
      process.env.AUTOMATED_ORDER_DELAY,
      process.env.HOW_LONG_WAIT_BEFORE_REFUNDING,
    ])
      .then((orders) => {
        if (orders.length > 0) {
          const orderNumbers = orders.map((order) => order.order_number);
          console.log(
            `The following order numbers will be sent to Printify: ${orderNumbers.join(
              ", "
            )}`
          );

          const promises = orders.map((order) => {
            //Determine shipping method
            let shippingMethod;
            if (order.shipping_speed.printify_shipping_method === "Standard") {
              shippingMethod = 1;
            } else if (
              order.shipping_speed.printify_shipping_method === "Priority"
            ) {
              shippingMethod = 2;
            }

            //Determine items to be ordered
            let orderedItems = order.ordered_items
              .filter((item) => item.item_is_for_printify === "Yes")
              .map(({ sku, quantity }) => ({ sku, quantity }));
            //Add the shipping region SKU to each sku
            orderedItems = orderedItems.map((item) => {
              item.sku = `${item.sku}${order.printify_sku_region}`;
              return item;
            });

            const orderData = {
              external_id: order.order_number.toString(),
              label: "",
              line_items: orderedItems,
              shipping_method: shippingMethod,
              send_shipping_notification:
                process.env.PRINTIFY_SHIPPING_NOTIFICATIONS === "on"
                  ? true
                  : false,
              address_to: {
                first_name: order.shipping_address_details.first_name,
                last_name: order.shipping_address_details.last_name,
                email: order.shipping_address_details.email,
                phone: "",
                country: order.shipping_address_details.country_code,
                region: order.shipping_address_details.province,
                address1: order.shipping_address_details.address1,
                address2: order.shipping_address_details.address2,
                city: order.shipping_address_details.city,
                zip: order.shipping_address_details.zip,
              },
            };

            //console.log(`Order ${order.order_number} will be sent to Printify with the following data:`, orderData);

            return (
              axios
                .post(
                  `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/orders.json`,
                  orderData,
                  {
                    headers: {
                      Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
                    },
                  }
                )
                //Printify API RESPONSE
                .then((response) => {
                  ordersSuccessfullySentToPrintify.push(order.order_number);

                  // Add new key/value pair to response.data
                  response.data.sent_to_production = "No";

                  // Update the order_sent_to_printify field in the database with the response
                  return db
                    .none(
                      "UPDATE orders SET order_sent_to_printify = $1 WHERE order_number = $2",
                      [response.data, order.order_number]
                    )
                    .catch((error) => {
                      console.error(
                        `Failed to update order ${order.order_number} in the database:`,
                        error
                      );
                    });
                })
                //PRINTIFY API ERROR
                .catch((error) => {
                  let currentTime = new Date();
                  let createdAt = new Date(order.created_at);

                  // Convert both dates to ISO strings (UTC)
                  let currentTimeUTC = currentTime.toISOString();
                  let createdAtUTC = createdAt.toISOString();

                  // Calculate the difference in hours
                  let hoursDifference =
                    Math.abs(
                      new Date(currentTimeUTC) - new Date(createdAtUTC)
                    ) / 36e5;

                  //if it isnt a temporary error then add it to the failed orders array for email notification
                  if (
                    error.response.data.message !==
                    "Action temporarily unavailable, please try again in two hours."
                  ) {
                    console.log(
                      `Order ${
                        order.order_number
                      } failed to send to Printify. Error: ${JSON.stringify(
                        error.response.data
                      )}`
                    );
                    console.log(
                      `${order.order_number} - failed to send to Printify "${error.response.data.errors.reason}", ordered items were: ${orderedItems}`
                    );

                    ordersFailedToSendToPrintify.push(
                      `${order.order_number} - ${error.response.data.errors.reason}`
                    );
                    ordersFailedToSendToPrintifyNumbers.push(
                      order.order_number
                    );

                    return db
                      .none(
                        "UPDATE orders SET order_sent_to_printify = $1 WHERE order_number = $2",
                        [error.response.data, order.order_number]
                      )
                      .catch((dbError) => {
                        console.error(
                          `Failed to update order ${order.order_number} in the database (with it's error object):`,
                          dbError
                        );
                      });

                    //else if its a temp error and its been over 4 hours since first attempted creation, then add it
                    //to the failed orders array for email notification
                  } else if (
                    error.response.data.message ===
                      "Action temporarily unavailable, please try again in two hours." &&
                    hoursDifference >
                      Number(process.env.AUTOMATED_ORDER_DELAY) + 4
                  ) {
                    ordersFailedToSendToPrintify.push(
                      `${order.order_number} - ${error.response.data}`
                    );
                    ordersFailedToSendToPrintifyNumbers.push(
                      order.order_number
                    );

                    return db
                      .none(
                        "UPDATE orders SET order_sent_to_printify = $1, has_been_cancelled = $3 WHERE order_number = $2",
                        [
                          error.response.data,
                          order.order_number,
                          "Temp Error - 3 hour aborted",
                        ]
                      )
                      .catch((dbError) => {
                        console.error(
                          `Failed to update order ${order.order_number} in the database (with it's error object):`,
                          dbError
                        );
                      });
                  } else {
                    //the other alternative is that it is a temp error and its been less than 3 hours since first attempted creation, then dont add it
                    //to the failed orders array for email notification
                    return db
                      .none(
                        "UPDATE orders SET order_sent_to_printify = $1 WHERE order_number = $2",
                        [error.response.data, order.order_number]
                      )
                      .catch((dbError) => {
                        console.error(
                          `Failed to update order ${order.order_number} in the database (with it's error object):`,
                          dbError
                        );
                      });
                  }
                })
            );
          });

          Promise.allSettled(promises)
            .then(() => {})
            .catch((error) => {
              console.error(
                "Error completing promises when sending orders to Printify:",
                error
              );
            })
            .finally(() => {
              if (ordersSuccessfullySentToPrintify.length > 0) {
                console.log(
                  `The following orders were successfully sent to Printify: ${ordersSuccessfullySentToPrintify.join(
                    ", "
                  )}`
                );
              }
              if (ordersFailedToSendToPrintify.length > 0) {
                console.log(
                  `The following orders failed to be sent to Printify: ${ordersFailedToSendToPrintify.join(
                    ", "
                  )}`
                );
              }
              console.log(
                `Cron job to send orders to Printify completed successfully`
              );

              if (ordersFailedToSendToPrintify.length > 0) {
                // Convert the array into a user-friendly string
                const failedOrdersString =
                  ordersFailedToSendToPrintify.join(", ");
                const failedOrdersNumbersString =
                  ordersFailedToSendToPrintifyNumbers.join(", ");
                //Send an email
                // Modify the email subject and body to include the failed orders
                const emailSubject = `SOME ORDERS NEED MANUAL FULFILLMENT: ${failedOrdersNumbersString}`;
                const emailBody = `There was an error when sending the following orders to Printify: ${failedOrdersString}. These orders will need to be completed manually.`;

                const msg = {
                  to: process.env.EMAIL_TO,
                  from: process.env.EMAIL_FROM,
                  subject: emailSubject,
                  text: emailBody,
                  html: `<p>${emailBody}</p>`,
                };

                sgMail
                  .send(msg)
                  .then(() => {
                    console.log(
                      `Email sent - ${failedOrdersNumbersString} Need Manual Fulfillment`
                    );
                  })
                  .catch((error) => {
                    console.error(error);
                  });
              }
            });
        } else {
          console.log("No orders to process");
        }
      })
      .catch((error) =>
        console.error(
          "Error checking the DB for which orders should be sent to Printify:",
          error
        )
      );
  });
}

function deleteOldOrders_CronJob(db) {
  cron.schedule("0 0 * * *", function () {
    const days = process.env.DAYS_BEFORE_DELETION || "28"; // Default to 28 if the env variable is not set
    console.log(
      `@@@ Running cron job to delete orders older than ${days} days`
    );
    db.none(
      `DELETE FROM orders WHERE NOW() - created_at > INTERVAL '${days} days'`
    )
      .then(() => console.log("Old orders deleted successfully"))
      .catch((error) => console.error("Error deleting old orders:", error));
  });
}

function sendPrintifyOrdersProduction_CronJob(db) {
  cron.schedule("32 * * * *", function () {
    console.log("@@@ Running cron job to send Printify orders to production");

    const errorsArray = [];
    const ordersSentToProduction = [];

    const sqlQuery = `
            SELECT * FROM orders 
            WHERE 
                order_sent_to_printify ->> 'sent_to_production' = 'No'
                AND order_sent_to_printify IS NOT NULL
                AND order_number >= 10154
                AND (EXTRACT(EPOCH FROM NOW() - created_at)/3600 >= $1 OR shopify_tags LIKE '%Automate now%')
        `;

    db.any(sqlQuery, [process.env.AUTOMATED_ORDER_DELAY])
      .then((orders) => {
        if (orders.length > 0) {
          const promises = orders.map((order) => {
            return axios
              .get(
                `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/orders/${order.order_sent_to_printify.id}.json`,
                {
                  headers: {
                    Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
                  },
                }
              )
              .then((response) => {
                ///TEST BLOCK
                //console.log(`Order ${order.order_number} Printify order info:`, response.data);
                ////////////////////////////////////////////
                const printifyOrderSKUs = response.data.line_items.map(
                  (item) => item.metadata.sku
                );
                const orderedItemsSKUs = order.ordered_items
                  .filter((item) => item.item_is_for_printify === "Yes")
                  .map((item) => `${item.sku}${order.printify_sku_region}`);
                const missingSKUs = orderedItemsSKUs.filter(
                  (sku) => !printifyOrderSKUs.includes(sku)
                );
                /////////////////////////////////////////////////////////////////////////////////////////
                // console.log(`${order.order_number} Printify order SKUs: `, printifyOrderSKUs);
                // console.log(`${order.order_number} Ordered items SKUs: `, orderedItemsSKUs);  //////tEST BLOCK
                // console.log(`${order.order_number} Missing SKUs: `, missingSKUs);
                //////////////////////////////////////////////////////////////////////////////////////////
                if (missingSKUs.length > 0) {
                  console.log(
                    `${order.order_number} Printify order SKUs: `,
                    printifyOrderSKUs
                  );
                  console.log(
                    `${order.order_number} Ordered items SKUs: `,
                    orderedItemsSKUs
                  );
                  console.log(
                    `${order.order_number} Missing SKUs: `,
                    missingSKUs
                  );

                  //Send an email
                  const emailSubject = `${order.order_number} Needs Manual Fulfillment`;
                  const emailBody = `When sending ${order.order_number} to Printify some products haven't been created in the order: ${missingSKUs}, this order will need to be completed manually`;

                  const msg = {
                    to: process.env.EMAIL_TO,
                    from: process.env.EMAIL_FROM,
                    subject: emailSubject,
                    text: emailBody,
                    html: `<p>${emailBody}</p>`,
                  };

                  sgMail
                    .send(msg)
                    .then(() => {
                      console.log(
                        `${order.order_number} Needs Manual Fulfillment`
                      );
                    })
                    .catch((error) => {
                      console.error(error);
                    });

                  // Update the order_sent_to_printify field to Error in the database
                  return db
                    .none(
                      "UPDATE orders SET order_sent_to_printify = jsonb_set(order_sent_to_printify, '{sent_to_production}', '\"Error\"') WHERE order_number = $1",
                      [order.order_number]
                    )
                    .catch((error) => {
                      console.error(
                        `Failed to update order ${order.order_number} sent_to_production value in the database:`,
                        error
                      );
                    });
                } else {
                  /////test block
                  //console.log(`Order ${order.order_number} has no missing SKUs so it will be sent to production with id ${order.order_sent_to_printify.id}`)
                  //ELSE IF THERE ARE NO MISSING SKUS THEN SEND THE ORDER TO PRODUCTION
                  ordersSentToProduction.push(order.order_number);
                  // ALSO, SET THE printify_tracking_number TO THE RESPONSE
                  // ADD carrier, tracking_url, tracking_number, posted_to_shopify as new keys TO THE RESPONSE object with empty STRING values
                  return axios
                    .post(
                      `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/orders/${order.order_sent_to_printify.id}/send_to_production.json`,
                      {},
                      {
                        headers: {
                          Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
                        },
                      }
                    )
                    .then((response) => {
                      ////test block
                      //console.log(`Order ${order.order_number} Printify production response:`, response.data);

                      if (response.data.hasOwnProperty("id")) {
                        //console.log(`Order ${order.order_number} has an id property so db being updated`)
                        // Add new keys to the response object
                        response.data.carrier = "";
                        response.data.tracking_url = "";
                        response.data.tracking_number = "";
                        response.data.posted_to_shopify = "";

                        // Update the printify_tracking_number field in the database with the updated response object
                        //If it was successful then update the order_sent_to_printify field in the database to "yes"
                        return db
                          .none(
                            "UPDATE orders SET printify_tracking_number = $1, order_sent_to_printify = jsonb_set(order_sent_to_printify, '{sent_to_production}', '\"Yes\"') WHERE order_number = $2",
                            [response.data, order.order_number]
                          )
                          .catch((error) => {
                            //log the error message
                            console.error(
                              `Failed to update order ${order.order_number} in the database message:`,
                              error.message
                            );
                            console.error(
                              `Failed to update order ${order.order_number} in the database full error:`,
                              error
                            );
                          });
                      } else {
                        errorsArray.push(`${order.order_number}`);
                        console.log(
                          `Error with response when sending order ${order.order_number} to production - ${response.data}`
                        );
                      }
                    })
                    .catch((error) => {
                      console.error(
                        `POST Failed to send order ${order.order_number} to production:`,
                        error.message
                      );
                      //console.error(`POST Failed to send order ${order.order_number} to production:`, error);
                      // Log the status code and status text
                      if (error.response) {
                        console.error(
                          `Response status:`,
                          error.response.status
                        );
                        console.error(
                          `Status text:`,
                          error.response.statusText
                        );

                        // Log the headers
                        console.error(`Headers:`, error.response.headers);

                        // Log the response data
                        console.error(`Data:`, error.response.data);
                      }

                      // Log the request that was made
                      if (error.request) {
                        console.error(`Request made:`, error.request);
                      }

                      errorsArray.push(`${order.order_number}`);
                    });
                }
              })
              .catch((error) => {
                console.error(
                  `Error getting created order info from Printify for ${order.order_number}:`,
                  error
                );
                errorsArray.push(`${order.order_number}`);
              });
          });

          Promise.allSettled(promises)
            .then((results) => {
              results.forEach((result, index) => {
                if (result.status === "rejected") {
                  console.error(
                    `Promise at index ${index} rejected with ${result.reason}`
                  );
                }
              });
            })
            .catch((error) => {
              console.error(
                "Error completing promises when sending orders to Printify:",
                error
              );
            })
            .finally(() => {
              if (ordersSentToProduction.length > 0) {
                console.log(
                  `The following orders are going to be sent to production: ${ordersSentToProduction.join(
                    ", "
                  )}`
                );
              }

              if (errorsArray.length > 0) {
                // Update each order's sent_to_production value to "Error"
                errorsArray.forEach((orderNumber) => {
                  db.none(
                    "UPDATE orders SET order_sent_to_printify = jsonb_set(order_sent_to_printify, '{sent_to_production}', '\"Error\"') WHERE order_number = $1",
                    [orderNumber]
                  ).catch((error) => {
                    console.error(
                      `Failed to update order ${orderNumber} sent_to_production value in the database:`,
                      error
                    );
                  });
                });

                // Convert the array into a user-friendly string
                const failedOrdersString = errorsArray.join(", ");

                // Send an email
                const emailSubject = `SOME ORDERS NEED MANUAL FULFILLMENT: ${failedOrdersString}`;
                const emailBody = `There was an error when sending the following orders to production in Printify: ${failedOrdersString}. These orders will need to be completed manually.`;

                const msg = {
                  to: process.env.EMAIL_TO,
                  from: process.env.EMAIL_FROM,
                  subject: emailSubject,
                  text: emailBody,
                  html: `<p>${emailBody}</p>`,
                };

                sgMail
                  .send(msg)
                  .then(() => {
                    console.log(
                      `Email sent - ${failedOrdersString} Need Manual Fulfillment`
                    );
                  })
                  .catch((error) => {
                    console.error(error);
                  });
              }
            });
        }
      })
      .catch((error) => {
        console.error("Error getting orders from the database:", error);
      });

    console.log("Sending Printify orders to production cron completed");
  });
}

function getTrackingInfo_CronJob(db) {
  cron.schedule("41 * * * *", function () {
    console.log("@@@ Running cron job to get tracking numbers from Printify");

    //Query for use when orders are being sent to production
    // Modified code to include OR order_sent_to_printify ->> 'sent_to_production' = 'Error'
    // because there is no harm in checking whether there is tracking info for these orders as they may have been manually sent
    // not using just IS NOT NULL because error object is sometimes stored in the order_sent_to_printify field so there may be no ID
    // const sqlQuery = `
    //     SELECT * FROM orders
    //     WHERE
    //         (order_sent_to_printify ->> 'sent_to_production' = 'Yes' OR order_sent_to_printify ->> 'sent_to_production' = 'Error')
    //         AND order_sent_to_printify IS NOT NULL
    //         AND printify_tracking_number ->> 'tracking_number' = ''
    //         AND printify_tracking_number ->> 'posted_to_shopify' = ''
    //         AND printify_tracking_number ->> 'id' != ''
    //         AND printify_tracking_number IS NOT NULL
    //         AND order_number > 10154
    // `;
    // Modified it to include when printify_tracking_number IS NULL because of the client submitting orders to production manually which results in 'sent_to_production' = 'Error'
    const sqlQuery = `
            SELECT * FROM orders 
            WHERE 
                (order_sent_to_printify ->> 'sent_to_production' = 'Yes' OR order_sent_to_printify ->> 'sent_to_production' = 'Error')
                AND order_sent_to_printify IS NOT NULL
                AND (printify_tracking_number IS NULL OR (printify_tracking_number ->> 'tracking_number' = '' AND printify_tracking_number ->> 'posted_to_shopify' = ''))
                AND order_number > 10154
        `;

    db.any(sqlQuery)
      .then((orders) => {
        //log to the console all of the order numbers that are being checked (just needed for testing)
        const orderNumbers = orders.map((order) => order.order_number);
        //console.log(`The following order numbers will be checked for tracking info: ${orderNumbers.join(', ')}`);

        //needs to be promise based
        const promises = orders.map((order) => {
          return axios
            .get(
              `https://api.printify.com/v1/shops/${process.env.PRINTIFY_SHOP_ID}/orders/${order.order_sent_to_printify.id}.json`,
              {
                headers: {
                  Authorization: `Bearer ${process.env.PRINTIFY_API_KEY}`,
                },
              }
            )
            .then((response) => {
              //The response doesnt have a shipments property unless the order has been dispatched
              if (response.data.hasOwnProperty("shipments")) {
                const carrier = response.data.shipments[0].carrier;
                const trackingNumber = response.data.shipments[0].number;
                const trackingURL = response.data.shipments[0].url;

                // Check if printify_tracking_number is null and create the printify_tracking_number object if it is
                if (order.printify_tracking_number === null) {
                  return db
                    .none(
                      `
                            UPDATE orders 
                            SET printify_tracking_number = $1
                            WHERE order_number = $2
                            `,
                      [
                        JSON.stringify({
                          id: order.order_sent_to_printify.id,
                          carrier: carrier,
                          tracking_url: trackingURL,
                          tracking_number: trackingNumber,
                          posted_to_shopify: "",
                        }),
                        order.order_number,
                      ]
                    )
                    .catch((error) => {
                      console.error(
                        `Failed to update order ${order.order_number} in the database:`,
                        error
                      );
                    });
                } else {
                  // Update the printify_tracking_number field in the database
                  return db
                    .none(
                      `
                            UPDATE orders 
                            SET printify_tracking_number = jsonb_set(
                                jsonb_set(
                                    jsonb_set(
                                        printify_tracking_number, 
                                        '{carrier}', 
                                        $1::jsonb
                                    ),
                                    '{tracking_url}', 
                                    $2::jsonb
                                ),
                                '{tracking_number}', 
                                $3::jsonb
                            )
                            WHERE order_number = $4
                            `,
                      [
                        JSON.stringify(carrier),
                        JSON.stringify(trackingURL),
                        JSON.stringify(trackingNumber),
                        order.order_number,
                      ]
                    )
                    .catch((error) => {
                      console.error(
                        `Failed to update order ${order.order_number} in the database:`,
                        error
                      );
                    });
                }
              }
            })
            .catch((error) => {
              console.error(
                `Error getting tracking info from Printify for ${order.order_number}:`,
                error
              );
            });
        });

        Promise.allSettled(promises)
          .then(() => {})
          .catch((error) => {
            console.error(
              "Error completing promises when getting tracking info from Printify:",
              error
            );
          })
          .finally(() => {
            console.log(
              `Cron job to get tracking info from Printify completed`
            );
          });
      })
      .catch((error) => {
        console.error(
          "Error getting orders from the database for tracking info:",
          error
        );
      });
  });
}

function postTrackingInfoToShopify_CronJob(db) {
  cron.schedule("50 * * * *", function () {
    console.log("@@@ Running cron job to post tracking numbers to Shopify");

    const noFulfillmentErrorsArray = []; //basically if the order hasnt been marked as fulfilled on Shopify
    const errorsArray = []; //if there is an error posting the tracking info to Shopify
    const successfullyUpdatedArray = []; //if the tracking info was successfully posted to Shopify

    const sqlQuery = `
            SELECT * FROM orders 
            WHERE
                printify_tracking_number ->> 'posted_to_shopify' = ''
                AND printify_tracking_number ->> 'tracking_number' != ''
                AND printify_tracking_number IS NOT NULL
                AND order_number > 10164
        `;

    db.any(sqlQuery)
      .then((orders) => {
        //log to the console all of the order numbers that are being checked (just needed for testing)
        const orderNumbers = orders.map((order) => order.order_number);
        console.log(
          `The following order numbers will have their tracking info posted to Shopify: ${orderNumbers.join(
            ", "
          )}`
        );

        //needs to be promise based
        const promises = orders.map((order, index) => {
          // Delay each request by 1 second * index
          return new Promise((resolve) =>
            setTimeout(resolve, index * 1000)
          ).then(() => {
            //first get the fulfillment id
            return axios
              .get(
                `${process.env.STORE_URL}/admin/api/2023-07/orders/${order.order_id}.json`,
                {
                  headers: {
                    "X-Shopify-Access-Token": process.env.SHOPIFY_ACCESS_TOKEN,
                  },
                }
              )
              .then((response) => {
                //console.log(`Order ${order.order_number} Shopify order info:`, response.data);

                if (
                  response.data.order.fulfillments.length > 0 &&
                  response.data.order.fulfillments[0].id
                ) {
                  const fulfillmentID = response.data.order.fulfillments[0].id;
                  return axios
                    .post(
                      `${process.env.STORE_URL}/admin/api/2023-07/fulfillments/${fulfillmentID}/update_tracking.json`,
                      {
                        fulfillment: {
                          notify_customer: true,
                          tracking_info: {
                            number:
                              order.printify_tracking_number.tracking_number,
                            url: order.printify_tracking_number.tracking_url,
                            company: order.printify_tracking_number.carrier,
                          },
                        },
                      },
                      {
                        headers: {
                          "X-Shopify-Access-Token":
                            process.env.SHOPIFY_ACCESS_TOKEN,
                        },
                      }
                    )
                    .then((response) => {
                      //console.log(`Order ${order.order_number} Shopify tracking info response:`, response.data);

                      successfullyUpdatedArray.push(`${order.order_number}`);
                      //console.log(`Order ${order.order_number} tracking info successfully posted to Shopify`, response.data);
                      // Update the printify_tracking_number field in the database
                      return db
                        .none(
                          "UPDATE orders SET printify_tracking_number = jsonb_set(printify_tracking_number, '{posted_to_shopify}', '\"Yes\"') WHERE order_number = $1",
                          [order.order_number]
                        )
                        .catch((error) => {
                          console.error(
                            `Failed to update order ${order.order_number} in the database:`,
                            error
                          );
                        });
                    })
                    .catch((error) => {
                      console.error(
                        `POST Failed to update tracking on Shopify for order ${order.order_number}`,
                        error.message
                      );
                      //console.error(`POST Failed to send order ${order.order_number} to production:`, error);
                      errorsArray.push(`${order.order_number}`);
                      // Update the printify_tracking_number field in the database to Error
                      return db
                        .none(
                          "UPDATE orders SET printify_tracking_number = jsonb_set(printify_tracking_number, '{posted_to_shopify}', '\"Error\"') WHERE order_number = $1",
                          [order.order_number]
                        )
                        .catch((error) => {
                          console.error(
                            `Failed to update order ${order.order_number} in the database:`,
                            error
                          );
                        });
                    });
                } else {
                  console.log(
                    `Order ${order.order_number} has no fulfillment id`
                  );
                  noFulfillmentErrorsArray.push(order.order_number);
                  return db
                    .none(
                      "UPDATE orders SET printify_tracking_number = jsonb_set(printify_tracking_number, '{posted_to_shopify}', '\"Error\"') WHERE order_number = $1",
                      [order.order_number]
                    )
                    .catch((error) => {
                      console.error(
                        `Failed to update order ${order.order_number} in the database:`,
                        error
                      );
                    });
                }
              })
              .catch((error) => {
                console.error(
                  `Error getting order info from Shopify for ${order.order_number}:`,
                  error.message
                );
                errorsArray.push(order.order_number);
                return db
                  .none(
                    "UPDATE orders SET printify_tracking_number = jsonb_set(printify_tracking_number, '{posted_to_shopify}', '\"Error\"') WHERE order_number = $1",
                    [order.order_number]
                  )
                  .catch((error) => {
                    console.error(
                      `Failed to get order ${order.order_number} info from Shopify GET request:`,
                      error
                    );
                  });
              });
          });
        });

        Promise.allSettled(promises)
          .then((results) => {
            results.forEach((result, index) => {
              if (result.status === "rejected") {
                console.error(
                  `Promise at index ${index} rejected with ${result.reason}`
                );
              }
            });
          })
          .catch((error) => {
            console.error(
              "Error completing promises when posting tracking info to Shopify:",
              error
            );
          })
          .finally(() => {
            if (noFulfillmentErrorsArray.length > 0) {
              // Convert the array into a user-friendly string
              const failedOrdersString = noFulfillmentErrorsArray.join(", ");

              // Send an email
              const emailSubject = `SOME ORDERS NEED SHOPIFY TRACKING INFO UPDATING MANUALLY: ${failedOrdersString}`;
              const emailBody = `(Note this could be caused because the order/s havent already been marked as fulfilled in Shopify?) - There was an error when trying to add the tracking info to Shopify, for the following orders: ${failedOrdersString}. These orders will need to be completed manually.`;

              const msg = {
                to: process.env.EMAIL_TO,
                from: process.env.EMAIL_FROM,
                subject: emailSubject,
                text: emailBody,
                html: `<p>${emailBody}</p>`,
              };

              sgMail
                .send(msg)
                .then(() => {
                  console.log(
                    `Email sent - ${failedOrdersString} Need Shopify tracking info updating manually`
                  );
                })
                .catch((error) => {
                  console.error(error);
                });
            }
            if (errorsArray.length > 0) {
              // Convert the array into a user-friendly string
              const failedOrdersString = errorsArray.join(", ");

              // Send an email
              const emailSubject = `SOME ORDERS NEED SHOPIFY TRACKING INFO UPDATING MANUALLY: ${failedOrdersString}`;
              const emailBody = `There was an error when trying to add the tracking info to Shopify, for the following orders: ${failedOrdersString}`;

              const msg = {
                to: process.env.EMAIL_TO,
                from: process.env.EMAIL_FROM,
                subject: emailSubject,
                text: emailBody,
                html: `<p>${emailBody}</p>`,
              };

              sgMail
                .send(msg)
                .then(() => {
                  console.log(
                    `Email sent - ${failedOrdersString} Need Shopify tracking info updating manually`
                  );
                })
                .catch((error) => {
                  console.error(error);
                });
            }
            if (successfullyUpdatedArray.length > 0) {
              console.log(
                `The following orders had their tracking info successfully posted to Shopify: ${successfullyUpdatedArray.join(
                  ", "
                )}`
              );
            }

            console.log(`Cron job to post tracking info to Shopify completed`);
          });
      })
      .catch((error) => {
        console.error(
          "Error getting orders from the database for posting tracking info to Shopify:",
          error
        );
      });

    console.log("Posting tracking info to Shopify cron completed");
  });
}

module.exports = {
  SyncDBWithShopify_CronJob,
  cancellation48Hours_CronJob,
  sendOrdersToPrintify_CronJob,
  deleteOldOrders_CronJob,
  sendPrintifyOrdersProduction_CronJob,
  getTrackingInfo_CronJob,
  postTrackingInfoToShopify_CronJob,
};
