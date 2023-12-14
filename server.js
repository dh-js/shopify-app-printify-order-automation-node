const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { SyncDBWithShopify_CronJob, cancellation48Hours_CronJob, sendOrdersToPrintify_CronJob, deleteOldOrders_CronJob, sendPrintifyOrdersProduction_CronJob, getTrackingInfo_CronJob, postTrackingInfoToShopify_CronJob } = require('./cronJobs');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY);
const basicAuth = require('express-basic-auth');
const app = express();
//uses the port variable set in Render, or 1008
const PORT = process.env.PORT || 1008;
//the following line is necessary to parse the body of the request
app.use(express.json());

//Checking for environment - if the code is running on Render then it will have a NODE_ENV of production
console.log('Running in:', process.env.NODE_ENV || 'no environment specified');
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

//console.log(`Env variable for HOW_LONG_WAIT_BEFORE_REFUNDING: ${process.env.HOW_LONG_WAIT_BEFORE_REFUNDING}`)

//################################################## START OF TABLE CREATION CODE ########################################
const pgp = require('pg-promise')();

const connection = {
  host: process.env.DB_HOST, // Hostname of PostgreSQL instance
  port: process.env.DB_PORT, // Port number
  database: process.env.DB_DATABASE, // Database name
  user: process.env.DB_USER, // Username
  password: process.env.DB_PASSWORD // Password
};

const db = pgp(connection);

// Create the table if it doesn't exist (optionally drop the table first)
async function setupDatabase() {
  try {

    // Drop the existing table - comment out this line if don't want to drop the table
    // await db.none('DROP TABLE IF EXISTS orders');
    // console.log('Table dropped');

    // Check if the table exists (this should now always return false)
    const result = await db.oneOrNone("SELECT to_regclass('public.orders')");
    
    if (result && result.to_regclass) {
      console.log('Table already exists');
    } else {
      // Create the table with the new schema
      await db.none(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          order_number INTEGER,
          order_sent_to_printify JSONB,
          printify_tracking_number JSONB,
          has_been_cancelled VARCHAR(70),
          shopify_tags VARCHAR(350),
          has_printify_items VARCHAR(50),
          ordered_items JSONB,
          required_info_warning VARCHAR(30)[],
          shipping_address_details JSONB,
          printify_sku_region VARCHAR(10),
          shipping_speed JSONB,
          notification_sent_to_kevin VARCHAR(50),
          order_id BIGINT UNIQUE,
          created_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ
        )
      `);
      console.log('Table created');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

//NOTES
//has_printify_items VARCHAR(50), --OPTIONS: Yes, Partially, No (No SKUs / Numbered SKUs), No (Unknown)
//notification_sent_to_kevin VARCHAR(50), --IF has_printify_items != 'Yes' OR IF required_info_warning
//order_sent_to_printify JSONB, --Either null or contains the Printify response
//################################################## END OF TABLE CREATION CODE ########################################

// Define country code arrays for each shipping region
const US = ['US'];
const Canada = ['CA'];
const UK = ['GB'];
const Australia_NewZealand = ['AU', 'NZ'];
const EU = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];
const otherEuropeanCountries = ['AL', 'AD', 'AM', 'AZ', 'BA', 'BY', 'CH', 'FO', 'GE', 'GI', 'IS', 'LI', 'MC', 'ME', 'MK', 'NO', 'RS', 'RU', 'SM', 'UA', 'VA', 'GG', 'IM', 'JE'];
const allEuropeanCountries = [...EU, ...otherEuropeanCountries];

// Function to determine the shipping region for a given country code
const getShippingRegion = (countryCode) => {
  if (US.includes(countryCode)) {
    return '-US';
  }
  if (Canada.includes(countryCode)) {
    return '-CAN';
  }
  if (allEuropeanCountries.includes(countryCode)) {
    return '-EU';
  }
  if (UK.includes(countryCode)) {
    return '-UK';
  }
  if (Australia_NewZealand.includes(countryCode)) {
    return '-AUS';
  }
  return 'Unknown';
};

async function handleOrder(req, db) {

  // Extract the order number from the request body for the log, and order_id to check the row's existing values
  const {
    id: order_id,
    order_number
  } = req.body;

  // Check if this order_id already exists and if it has already been sent to Printify
  const existingOrder = await db.oneOrNone('SELECT * FROM orders WHERE order_id = $1', [order_id]);

  if (existingOrder && existingOrder.order_sent_to_printify !== null) {
    // If the order already exists and has been sent to Printify, send a 200 response and do nothing
    //console.log(`Order number ${order_number} has already been sent to Printify, ignoring`);
    return 'Order already sent to Printify';

  //Check if this order_id already exists and if it has already been cancelled
  // } else if (existingOrder && existingOrder.has_been_cancelled !== '') {
  //   // If the order already exists and has been cancelled, send a 200 response and do nothing
  //   console.log(`Order number ${order_number} has already been cancelled, ignoring`);
  //   return 'Order already cancelled';

  // Otherwise, if the order doesn't exist or has not been sent to Printify or cancelled, continue
  } else {
    // Deconstruct info from req.body
    const {
      cancel_reason,
      financial_status,
      created_at,
      tags,
      shipping_address,
      line_items,
      refunds,
      shipping_lines,
      customer
    } = req.body;

    // Deconstruct shipping details
    const {
      first_name,
      last_name,
      address1,
      address2,
      city,
      country_code,
      province_code: province,
      zip,
      name
    } = shipping_address || {};

    // Deconstruct email
    const {
      email
    } = customer || {};

    // Add shipping details to new shipping_address_details object
    const shipping_address_details = {
      first_name,
      last_name,
      address1,
      address2,
      city,
      country_code,
      province,
      zip,
      name,
      email
    };

    // Deconstruct for shipping speed/method
    const {
      title: shopify_shipping_title,
      price: shopify_shipping_price
    } = shipping_lines[0] || {};

    //DEFAULT VALUES
    let has_printify_items = null;
    let order_sent_to_printify = null;
    let printify_tracking_number = null;
    let updated_at = null;

    let shopify_tags = tags;

    //################################################## START OF ORDERED ITEMS LOGIC ########################################
    
    // CREATE ordered_items ARRAY OF EACH ITEM, FOR TABLE COLUMN
    const ordered_items = line_items.map(item => {
      let itemFulfilledByPrintify;
      // Regular expression to match SKUs that only contain numbers and '_' or '-'
      const printfulSkuPattern = /^[0-9_-]+$/;
      if (item.sku === '' || item.sku === null) {
        itemFulfilledByPrintify = 'Missing SKU';
      } else if (printfulSkuPattern.test(item.sku)) {
        itemFulfilledByPrintify = 'Printful SKU';
      } else {
        itemFulfilledByPrintify = 'Yes';
      }
      return {
        sku: item.sku,
        quantity: item.quantity,
        id: item.id,
        item_is_for_printify: itemFulfilledByPrintify
      };
    });

    // LOOP THROUGH ordered_items ARRAY TO DETERMINE has_printify_items TABLE VALUE
    let yesCount = 0;
    let printfulSKUCount = 0;
    let missingSKUCount = 0;
    
    for (const item of ordered_items) {
      if (item.item_is_for_printify === 'Yes') {
        yesCount++;
      } else if (item.item_is_for_printify === 'Printful SKU') {
        printfulSKUCount++;
      } else if (item.item_is_for_printify === 'Missing SKU') {
        missingSKUCount++;
      }
    }

    if (yesCount === ordered_items.length) {
      has_printify_items = 'Yes';
    } else if (printfulSKUCount === ordered_items.length || missingSKUCount === ordered_items.length) {
      has_printify_items = 'No - (Printful SKUs or No SKUs)';
    } else if (yesCount > 0 && yesCount < ordered_items.length) {
      has_printify_items = 'Partially';
    } else {
      has_printify_items = 'No (Unknown)';
    }

    //################################################## END OF ORDERED ITEMS LOGIC #############################

    //################################################## START OF SHIPPING SPEED LOGIC #############################
    // Determine shipping speed based on Shopify shipping title - 1 is 'Standard', 2 is 'Priority'
    let shipping_speed = {};
    if (shopify_shipping_price) {
      if (shopify_shipping_price === '0.00') {
        shipping_speed.printify_shipping_method = 'Standard';
        shipping_speed.shopify_profile = shopify_shipping_title;
        shipping_speed.shopify_price = shopify_shipping_price;
      } else {
        shipping_speed.printify_shipping_method = 'Priority';
        shipping_speed.shopify_profile = shopify_shipping_title;
        shipping_speed.shopify_price = shopify_shipping_price;
      }
    }
    //################################################## END OF SHIPPING SPEED LOGIC #############################

    //################################################## START OF Printify SKU LOGIC #############################
    let printify_sku_region;
    try {
      printify_sku_region = getShippingRegion(shipping_address_details.country_code);
    } catch (error) {
      printify_sku_region = "Error";
    }
    //################################################## END OF Printify SKU LOGIC #############################

    //################################################## START OF CHECK ADDRESS FOR MISSING INFO #############################
    // Check if any of the shipping details are missing
    let required_info_warning = [];

    if (!address1 || address1.trim() === '') {
      required_info_warning.push('Address 1 Missing');
    }
    if (!city || city.trim() === '') {
      required_info_warning.push('City Missing');
    }
    if (!country_code || country_code.trim() === '') {
      required_info_warning.push('Country Code Missing');
    }
    if (!zip || zip.trim() === '') {
      required_info_warning.push('Zip Missing');
    }
    //First name / last name logic - includes checking for empty strings
    if (first_name && first_name.trim() !== '' && (!last_name || last_name.trim() === '')) {
      const nameArray = first_name.split(' ');
      shipping_address_details.first_name = nameArray[0];
      shipping_address_details.last_name = nameArray.length > 1 ? nameArray.slice(1).join(' ') : first_name;
    } else if ((!first_name ||  first_name.trim() === '') && last_name && last_name.trim() !== '') {
      const nameArray = last_name.split(' ');
      shipping_address_details.first_name = nameArray[0];
      shipping_address_details.last_name = nameArray.length > 1 ? nameArray.slice(1).join(' ') : last_name;
    } else if ((!first_name || first_name.trim() === '') && (!last_name || last_name.trim() === '') && name) {
      if (name.includes(' ') && name.trim() !== '') {
          const nameArray = name.split(' ');
          shipping_address_details.first_name = nameArray[0];
          shipping_address_details.last_name = nameArray.length > 1 ? nameArray.slice(1).join(' ') : name;
      } else {
        shipping_address_details.first_name = name;
        shipping_address_details.last_name = name;
      }
    } else if ((!first_name || first_name.trim() === '') && (!last_name || last_name.trim() === '')) {
      required_info_warning.push('First and Last Name Missing');
    }

    //if printify_sku_region	is 'Unknown' then add to required_info_warning
    if (printify_sku_region === 'Unknown') {
      required_info_warning.push('Unknown Printify SKU Region');
    } else if (printify_sku_region === 'Error') {
      required_info_warning.push('Error Determining Printify SKU Region');
    }

    //if shipping_speed is null then add to required_info_warning
    if (!shipping_speed.printify_shipping_method) {
      required_info_warning.push('Shipping Method Missing');
    }

    //So the possible values of required_info_warning are:
    //2. Unknown Printify SKU Region
    //3. Error Determining Printify SKU Region
    //4. First and Last Name Missing
    //5. Address 1 Missing
    //6. City Missing
    //7. Country Code Missing
    //8. Zip Missing

    //################################################## END OF CHECK ADDRESS FOR MISSING INFO #############################

    //Check cancellation status
    let has_been_cancelled = "";
    if (cancel_reason !== null) {
      has_been_cancelled = "Cancelled (won't be automated)";
    } else if (financial_status === "voided") {
      has_been_cancelled = "Financial Status indicates 'Voided' payment (won't be automated)";
    } else if (financial_status === "refunded") {
      has_been_cancelled = "Refunded (won't be automated)";
    } else if (financial_status === "partially_refunded") {
      has_been_cancelled = "Financial Status indicates 'Partially Refunded' (won't be automated)";
    } else if (financial_status === "partially_paid") {
      has_been_cancelled = "Financial Status indicates 'Partially Paid' (won't be automated)";
    } else if (refunds.length > 0) {
      has_been_cancelled = "Refunded or Partial Refund (won't be automated)";
    }

    //################################################## SEND EMAIL #############################
    let notification_sent_to_kevin = existingOrder ? existingOrder.notification_sent_to_kevin : "";
    notification_sent_to_kevin = notification_sent_to_kevin || "";

    let email_subject;
    let email_body = "<ul>";

    //Any required info warnings - send an email to Kevin
    if (required_info_warning.length > 0 && !notification_sent_to_kevin.includes('Required Info')) {
      email_subject = email_subject ? `${email_subject},  Required info warning` : `${order_number} - Required info warning`;
      email_body += `<li><b>Required Info Warning:</b> ${required_info_warning.join(', ')}</li>`;
      notification_sent_to_kevin += 'Required Info, ';
    }

    if (has_been_cancelled !== "" && !notification_sent_to_kevin.includes('Cancelled')) {
      email_subject = email_subject ? `${email_subject},  ${has_been_cancelled}` : `${order_number} - ${has_been_cancelled}`;
      email_body += `<li><b>${has_been_cancelled}</b></li>`;
      notification_sent_to_kevin += 'Cancelled, ';
    }

     //Any non-printify items - send an email to Kevin
    if (has_printify_items !== 'Yes' && process.env.NOTIFY_WHEN_NON_PRINTIFY_ITEM_IN_ORDER === 'true' && !notification_sent_to_kevin.includes('Non-Printify')) {
      email_subject = email_subject ? `${email_subject}, Contains non-Printify items` : `${order_number} - Contains non-Printify items`;
      email_body += `<li><b>Contains non-Printify items.</b> Ordered items:</li>`;
      ordered_items.forEach(item => {
        email_body += `<li><pre>${JSON.stringify(item, null, 2)}</pre></li>`;
      });
      notification_sent_to_kevin += 'Non-Printify, ';
    }

    email_body += "</ul>";

    //Anything but YES - send an email to Kevin
    if (email_subject) {
      const msg = {
        to: process.env.EMAIL_TO,
        from: process.env.EMAIL_FROM,
        subject: email_subject,
        text: email_body,
        html: email_body,
      };
      
      sgMail
        .send(msg)
        .then(() => {
          console.log(`Email sent: ${email_subject}`)
        })
        .catch((error) => {
          console.error(error)
        });
    }
    /////////////////////////////////////////////

    return db.one(`
      INSERT INTO orders (
        id,
        order_number,
        order_sent_to_printify,
        printify_tracking_number,
        has_been_cancelled,
        shopify_tags,
        has_printify_items,
        ordered_items,
        required_info_warning,
        shipping_address_details,
        printify_sku_region,
        shipping_speed,
        notification_sent_to_kevin,
        order_id,
        created_at,
        updated_at
      ) 
      VALUES (
        DEFAULT, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )
      ON CONFLICT (order_id) DO UPDATE SET
        order_number = EXCLUDED.order_number,
        order_sent_to_printify = EXCLUDED.order_sent_to_printify,
        printify_tracking_number = EXCLUDED.printify_tracking_number,
        has_been_cancelled = EXCLUDED.has_been_cancelled,
        shopify_tags = EXCLUDED.shopify_tags,
        has_printify_items = EXCLUDED.has_printify_items,
        ordered_items = EXCLUDED.ordered_items,
        required_info_warning = EXCLUDED.required_info_warning,
        shipping_address_details = EXCLUDED.shipping_address_details,
        printify_sku_region = EXCLUDED.printify_sku_region,
        shipping_speed = EXCLUDED.shipping_speed,
        notification_sent_to_kevin = EXCLUDED.notification_sent_to_kevin,
        created_at = EXCLUDED.created_at,
        updated_at = now()
      RETURNING (xmax = 0) AS is_insert
    `, [
      order_number,
      order_sent_to_printify,
      printify_tracking_number,
      has_been_cancelled,
      shopify_tags,
      has_printify_items,
      JSON.stringify(ordered_items),
      required_info_warning,
      shipping_address_details,
      printify_sku_region,
      shipping_speed,
      notification_sent_to_kevin,
      order_id,
      created_at,
      updated_at
    ])
    .then(({ is_insert }) => {
      //console.log(`Order number ${order_number}: ${is_insert ? 'New database entry' : 'Updated existing entry'}`);
      return is_insert ? 'New database entry' : 'Updated existing entry';
    })
    .catch(error => {
      console.error('Error saving order:', error);
      throw new Error('Internal Server Error');
    });
  }
}

app.get('/', (req, res) => {
    res.send('App is Running!');
});

app.get('/syncShopifyOrdersToDB', async (req, res) => {
  try {
    let url = `${process.env.STORE_URL}/admin/api/2023-07/orders.json?status=any`;
    const now = new Date();
    let stopLooping = false;
    let response;

    // Create arrays to store order numbers from the handleOrder function
    let newEntries = [];
    let updatedEntries = [];
    let alreadySent = [];

    while (url && !stopLooping) {
      response = await axios.get(url, {
        headers: {
          'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN
        }
      });

      // Loop through each order and handle it
      for (const order of response.data.orders) {
        // Create a mock request object to pass to handleOrder
        const mockReq = {
          body: order,
          headers: {}
        };

        // Convert the order's created_at timestamp to a Date object
        const orderDate = new Date(order.created_at);

        // Calculate the difference in hours between now and the order's created_at
        const hoursDifference = Math.abs(now - orderDate) / 36e5;

        // If the order is older than X hours, stop looping
        if (hoursDifference > Number(process.env.HOW_LONG_WAIT_BEFORE_REFUNDING)+ 1) {
          stopLooping = true;
          break;
        }

        // Call handleOrder for each order
      //   handleOrder(mockReq, db)
      //     .then(message => {
      //       //console.log(`Order ${order.order_number}: ${message}`);
      //     })
      //     .catch(error => {
      //       console.error(`Error handling order ${order.order_number}:`, error);
      //     });
      // }

      // Call handleOrder for each order
      await handleOrder(mockReq, db)
      .then(message => {
        // Add order number to the appropriate array
        if (message === 'New database entry') {
          newEntries.push(order.order_number);
        } else if (message === 'Updated existing entry') {
          updatedEntries.push(order.order_number);
        } else if (message === 'Order already sent to Printify') {
          alreadySent.push(order.order_number);
        }
      })
      .catch(error => {
        console.error(`Error handling order ${order.order_number}:`, error);
      });
  }

      // Check if there is a next page
      const linkHeader = response.headers.link;
      if (linkHeader) {
        const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
        url = match ? match[1] : null;
      } else {
        url = null;
      }
    }

    // Log the arrays of order numbers
    console.log('New database entries:', newEntries);
    //console.log('Updated existing entry:', updatedEntries);
    //console.log('Orders already sent to Printify:', alreadySent);
    
    if (response) {
      res.send('Orders processed successfully');
      // or send the response data in a pretty JSON format
      //res.send(`<pre>${JSON.stringify(response.data, null, 2)}</pre>`);
    } else {
      res.send('No orders processed');
    }

  } catch (error) {
    console.error('Error:', error);
    res.status(500).send('An error occurred');
  }

});

app.get('/viewOrders', 
  basicAuth({
    users: { 'admin': process.env.VIEW_ORDERS_PASSWORD },
    challenge: true,
    realm: 'Imb4T3st4pp',
  }),
  (req, res) => {
    db.any('SELECT * FROM orders ORDER BY order_number DESC')
    .then(data => {
      let html = `
        <style>
          table {width: 100%;}
          td, th {text-align: center;}
          th {
            position: sticky;
            top: 0;
            background-color: #fff; /* Add a background color to the header */
          }
        </style>
        <table border="1">`;
      html += '<tr>';
      for (const key in data[0]) {
        html += `<th>${key}</th>`;
      }
      html += '</tr>';
        
        for (const row of data) {
          html += '<tr>';
          for (const key in row) {
            if (key === 'printify_tracking_number') {
              let value = JSON.stringify(row[key], null, 2);
              html += `<td><pre>${value}</pre></td>`; // Convert object to JSON-formatted string
            } else if (key === 'created_at' || key === 'updated_at') {
              let formattedDate = 'null';
              if (row[key] !== null) {
                // Convert to Date object and format
                const date = new Date(row[key]);
                formattedDate = date.toLocaleString('en-US', { timeZone: 'America/New_York' }).replace(/ /g, '&nbsp;');
              }
              html += `<td>${formattedDate}</td>`;
            } else if (key === 'shipping_address_details') {
              // Custom formatting for shipping_address_details
              const orderedDetails = [
                'first_name', 
                'last_name', 
                'address1', 
                'address2', 
                'city', 
                'country_code', 
                'province', 
                'zip',
                'name',
                'email'
              ].map(k => `"${k}": "${row[key][k] || ''}"`).join('<br>');
              html += `<td><pre>{<br>${orderedDetails}<br>}</pre></td>`;
        
            } else if (key === 'ordered_items' || key === 'shipping_speed') {
              let value = JSON.stringify(row[key], null, 2);
              if (key === 'shipping_speed') {
                value = value.replace(/"printify_shipping_method": "(.*?)"/, '"printify_shipping_method": "<b>$1</b>"');
              }
              html += `<td><pre>${value}</pre></td>`; // Convert object to JSON-formatted string
            
            } else if (key === 'required_info_warning') {
              const flags = row[key] ? row[key].join(",<br>") : "None";
              html += `<td style="white-space: nowrap;"><b>${flags}</b></td>`;
            
            } else if (key === 'order_sent_to_printify') {
              html += `<td><pre>${JSON.stringify(row[key], null, 2)}</pre></td>`; // Convert object to JSON-formatted string
            
            } else {
              let value = row[key];
              if (key === 'order_number' || key === 'has_printify_items' || key === 'printify_sku_region') {
                value = `<b>${value}</b>`;
              }
              html += `<td>${value}</td>`;
            }
          }
          html += '</tr>';
        }

        html += '</table>';

        res.status(200).send(html);
      })
      .catch(error => {
        console.error('Error fetching orders:', error);
        res.status(500).send('Internal Server Error');
      });
});

// Call the async function to set up the database, then start the server only after the database is set up
setupDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      SyncDBWithShopify_CronJob();
      cancellation48Hours_CronJob(db);
      sendOrdersToPrintify_CronJob(db);
      deleteOldOrders_CronJob(db);
      sendPrintifyOrdersProduction_CronJob(db);
      getTrackingInfo_CronJob(db);
      postTrackingInfoToShopify_CronJob(db);
    });
  })
  // If there was an error setting up the database, log the error and exit the process
  .catch((error) => {
    console.error(`Failed to set up database: ${error}`);
  });