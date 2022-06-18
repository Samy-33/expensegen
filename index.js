import 'dotenv/config';

import crypto from 'crypto';
import sqlite from 'sqlite3';
import Puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const HDFC_LOGIN_URL = 'https://netbanking.hdfcbank.com/netbanking/';
const HDFC_USERNAME = process.env['HDFC_USERNAME'];
const HDFC_PASSWORD = process.env['HDFC_PASSWORD'];

const USERNAME_SELECTOR = 'input[name="fldLoginUserId"]';
const PASSWORD_SELECTOR = 'input[name="fldPassword"]';

async function login(loginFrame) {
  const inputElement = await loginFrame.$(USERNAME_SELECTOR);
  await inputElement.type(HDFC_USERNAME);

  const continueBtn = await loginFrame.$('.login-btn');
  await continueBtn.click();

  await loginFrame.waitForSelector(PASSWORD_SELECTOR);
  const passwordInputElement = await loginFrame.$(PASSWORD_SELECTOR);
  await passwordInputElement.type(HDFC_PASSWORD);

  const checkInput = await loginFrame.$('#chkrsastu');
  if (!!checkInput) {
    await checkInput.click();
  }

  const loginBtn = await loginFrame.$('a[class="btn btn-primary login-btn"]');
  await loginBtn.click();
}

async function goToRecentTransactionsAfterLogin(mainPartFrame) {
  await mainPartFrame.waitForSelector('#savingAcctList');
  const dropdownBtn = await mainPartFrame.$('#savingAcctList');
  await dropdownBtn.click();

  await mainPartFrame.waitForSelector('a[class=viewBtnGrey]');
  const viewBtn = await mainPartFrame.$('a[class=viewBtnGrey]');
  await viewBtn.click();
}

// this function runs in the browser, so all the dependencies must be
// considered to be in the browser's page.
function parseTable(table) {
  function parseCommaSeparatedAmount(commaSeparatedAmount) {
    return parseFloat(commaSeparatedAmount.replace(/,/g, ''));
  }

  const rows = Array.from(table.firstElementChild.childNodes).slice(1);
  return rows.map((row) => {
    const columns = row.childNodes;
    const isDebit = columns.item(4).textContent.trim().length !== 0;
    return {
      originalRowTextContent: row.textContent.trim(),
      date: new Date(columns.item(0).textContent.trim()).valueOf(),
      description: columns.item(1).textContent,
      amount: parseCommaSeparatedAmount(
        columns.item(4).textContent.trim() || columns.item(5).textContent.trim()
      ),
      isDebit,
      closingBalance: parseCommaSeparatedAmount(
        columns.item(6).textContent.trim()
      ),
    };
  });
}

function storeInDb(data) {
  const db = new sqlite.Database(process.env['DB_LOCATION']);
  db.serialize(() => {
    db.run(
      'create table if not exists expensegen(date integer, description text, amount float, is_debit integer, closing_balance float, checksum text)'
    );

    db.run(
      'create index if not exists expensegen_date_ind on expensegen(date)'
    );

    const checksums = data.map((d) => d.checksum);

    console.log(checksums);
    db.all(
      `select checksum from expensegen where checksum in (${checksums.map(() => '?')})`,
      checksums,
      (err, rows) => {
        if (err) {
          console.error('Got error while fetching checksums from db', err);
          db.close();
          return;
        }

        const matchedChecksums = rows.map(r => r.checksum);
        console.log(matchedChecksums);
        data.forEach((transaction) => {
          if (matchedChecksums.includes(transaction.checksum)) {
            console.log(`Data with checksum ${transaction.checksum} already exists, skipping`);
            return;
          }

          db.run(
            'insert into expensegen values(?, ?, ?, ?, ?, ?)',
            transaction.date,
            transaction.description,
            transaction.amount,
            transaction.isDebit ? 1 : 0,
            transaction.closingBalance,
            transaction.checksum
          );
        });

        db.close();
      }
    );
  });
}

function populateChecksums(data) {
  return data.map((transaction) =>
    Object.assign({}, transaction, {
      checksum: crypto
        .createHash('md5')
        .update(transaction.originalRowTextContent)
        .digest('hex'),
    })
  );
}

async function waitAndGetFrame(page, frameName) {
  const frameChecker = (f) => f.name() === frameName;
  await page.waitForFrame(frameChecker);
  return page.frames().find(frameChecker);
}

async function run() {
  const stealth = StealthPlugin();
  stealth.enabledEvasions.delete('user-agent-override');
  Puppeteer.use(stealth);

  const browser = await Puppeteer.launch();
  const page = await browser.newPage();

  page.on('dialog', async (dialog) => {
    console.log(dialog.message());
    console.log(
      'exiting as we got above mentioned dialog, needs human interaction'
    );
    await browser.close();
  });

  await page.goto(HDFC_LOGIN_URL);

  const loginFrame = await waitAndGetFrame(page, 'login_page');
  await login(loginFrame);
  await page.waitForNetworkIdle();

  const mainFrame = await waitAndGetFrame(page, 'main_part');
  await goToRecentTransactionsAfterLogin(mainFrame);
  await page.waitForNetworkIdle();

  const transactionTable = await mainFrame.$('table[class=datatable]');
  const data = populateChecksums(await transactionTable.evaluate(parseTable));

  storeInDb(data);
  await browser.close();
}

run();
