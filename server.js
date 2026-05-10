
const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Bernie's Inventory Scanner</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: #111;
            color: white;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
          }
          .box {
            width: 400px;
            text-align: center;
          }
          input {
            width: 100%;
            padding: 14px;
            font-size: 20px;
            margin-top: 20px;
          }
          button {
            padding: 12px 20px;
            margin-top: 20px;
            font-size: 18px;
            cursor: pointer;
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Bernie's Inventory Scanner</h1>
          <p>Deployment successful.</p>
          <input placeholder="Scan or type barcode" />
          <button>Test Button</button>
        </div>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
