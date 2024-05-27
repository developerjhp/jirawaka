require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');
const express = require('express');
const bodyParser = require('body-parser');
const JiraClient = require('jira-connector');

const app = express();
const port = 3001;

const settingPath = path.join(__dirname, 'settings');

app.use(bodyParser.json());

app.post('/api/save-config', (req, res) => {
  const configData = req.body;
  delete req.body?.today;
  const { projects } = configData;
  const projectArray = projects.replace(/\s/g, '').split(',');

  for (const project of projectArray) {
    if (!fs.existsSync(settingPath)) {
      fs.mkdirSync(settingPath);
    }

    fs.writeFile(`settings/${project}.json`, JSON.stringify({ ...configData, project }), 'utf8', err => {
      if (err) {
        console.error(err);
        return res.status(500).send('Error saving configuration');
      }
    });
  }

  res.send('Configuration saved successfully');
});

app.post('/api/submit-config', async (req, res) => {
  const { today, wakatimeApiKey, jiraApiKey, jiraServer, jiraUsername, project, assignDisplayName } = req.body;

  const jira = new JiraClient({
    host: jiraServer,
    basic_auth: {
      username: jiraUsername,
      password: jiraApiKey,
    },
  });

  const TODAY = today ?? getCurrentDateInTimezone(process.env.COUNTRY).toISOString().split('T')[0];
  const branchDurations = {};

  try {
    const wakatimeResponse = await axios.get(
      `https://wakatime.com/api/v1/users/current/durations?date=${TODAY}&project=${project}&api_key=${wakatimeApiKey}`
    );

    if (wakatimeResponse.status !== 200) {
      throw new Error('Failed to fetch from WakaTime API');
    }

    const wakatimeData = wakatimeResponse.data;

    for (const work of wakatimeData.data) {
      if (work.branch) {
        const projectMatchKey = new RegExp(`\\/${projectKey}-(\\d+)`, 'i');
        const match = work.branch.match(projectMatchKey);
        if (match) {
          const ticketNumber = match[0];
          if (!branchDurations[ticketNumber]) {
            branchDurations[ticketNumber] = 0;
          }
          branchDurations[ticketNumber] += work.duration;
        }
      }
    }

    let messages = [];
    for (const ticketNumber in branchDurations) {
      const totalDuration = Math.round(branchDurations[ticketNumber] / 60);
      const ticket = await jira.issue.getIssue({ issueKey: ticketNumber });

      if (ticket.fields.assignee && ticket.fields.assignee.displayName !== assignDisplayName) {
        messages.push(
          `Assignee is not ${assignDisplayName} for ticket ${ticket.key}, ${ticket.fields.assignee.displayName} is assigned.`
        );
        continue;
      }
      await jira.issue.addWorkLog({
        issueKey: ticket.key,
        worklog: {
          timeSpent: `${totalDuration}m`,
        },
      });

      messages.push(`${ticket.key} : ${totalDuration}m`);
    }

    const totalWorkTime = Math.round(Object.values(branchDurations).reduce((a, b) => a + b, 0) / 60) + 'm';
    const assigneeMessages = messages.filter(msg => msg.startsWith('Assignee is not'));

    res.json({
      messages,
      branchDurations,
      totalWorkTime,
    });

    onWorkCompleted(branchDurations, totalWorkTime, project, assigneeMessages, jiraUsername);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const logFilePath = project => path.join(__dirname, `log/${project}.log`);

function appendLog(message, project, jiraUsername) {
  const logDirectory = path.join(__dirname, 'log');
  if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
  }

  const timestamp = getCurrentDateInTimezone(process.env.COUNTRY).toISOString();
  const logMessage = `\n${message}\n${timestamp}\n`;

  fs.appendFile(logFilePath(project), logMessage, err => {
    if (err) {
      return console.error('Error appending to log file:', err);
    }

    sendEmail(jiraUsername, `${project} 작업시간 기록 완료`, message.split('\n').join('<br/>'));
  });
}

async function sendEmail(to, subject, html) {
  let transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  let info = await transporter.sendMail({
    from: `"Wakatime-Jira Integration" <${process.env.EMAIL_USER}>`,
    to: to,
    subject: subject,
    html: html,
  });

  console.log('Message sent: %s', info.messageId);
}

function onWorkCompleted(branchDurations, totalWorkTime, project, assigneeMessages, jiraUsername) {
  const timestamp = getCurrentDateInTimezone(process.env.COUNTRY).toISOString().split('T')[0];
  const logMessages = [`오늘 ${timestamp}`];

  assigneeMessages.forEach(message => logMessages.push(message));

  for (const [branch, duration] of Object.entries(branchDurations)) {
    const ticketNumber = branch.replace(`/${projectKey}-`, `${projectKey.toUpperCase()}-`);
    const durationInMinutes = Math.round(duration / 60);
    logMessages.push(`${ticketNumber} : ${durationInMinutes}m`);
  }

  logMessages.push(`각 브랜치별 작업시간 (초단위) ${JSON.stringify(branchDurations)}`);
  logMessages.push(`오늘 총 작업시간 (분단위): ${totalWorkTime}`);

  appendLog(logMessages.join('\n'), project, jiraUsername);
}

function getCurrentDateInTimezone(country) {
  const date = new Date();
  const timeZone = getTimeZoneByCountry(country);
  return new Date(date.toLocaleString('en-US', { timeZone }));
}

function getTimeZoneByCountry(country) {
  const timeZones = {
    Korea: 'Asia/Seoul',
    USA: 'America/New_York',
    // Add more countries and their timezones as needed
  };
  return timeZones[country] || 'UTC';
}
