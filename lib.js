const Promise = require('prfun')
const _ = require('lodash')
const axios = require('axios')
require('@3846masa/axios-cookiejar-support')(axios)
const tough = require('tough-cookie')
const Airtable = require('airtable')
const fs = require('fs')
const path = require('path')
const async = require('async')

async function bases (email, password, apiInfo = true) {
  const baseUrl = 'https://airtable.com'

  // cookies are required for the authentication to work
  const requestWithCookies = axios.create({
    jar: new tough.CookieJar(),
    withCredentials: true
  })

  const loginForm = await requestWithCookies.get(`${baseUrl}/login`)
  const _csrf = loginForm.data.match(/name="_csrf"\s*value="(\S*)"/)[1]

  const session = await requestWithCookies.post(`${baseUrl}/auth/login`, {_csrf, email, password})
  if (session.data.indexOf('redirectAfterSuccessfulLogin') === -1) {
    throw new Error('NotLoggedIn')
  }

  const app = await requestWithCookies.get(`${baseUrl}/auth/redirectAfterSuccessfulLogin`)
  const initData = JSON.parse(app.data.match(/initData.+?({.*})/)[1])

  let bases = _.mapValues(initData['rawApplications'], (app) => {
    return {
      name: app['name'],
      tables: _.fromPairs(_.map(app['visibleTableOrder'], (tableId) => {
        return [tableId, initData.rawTables[tableId].name]
      }))
    }
  })

  if (apiInfo) {
    bases = await Promise.props(_.mapValues(bases, async (base, baseId) => {
      const apiDocs = await requestWithCookies.get(`${baseUrl}/${baseId}/api/docs#curl/introduction`)
      const apiKey = apiDocs.data.match(/data-api-key="(\S*)"/)[1]

      return _.merge(base, {
        apiDocs: apiDocs.data,
        apiKey: apiKey
      })
    }))
  }

  return bases
}

function tableRecords (apiKey, baseId, tableId, done) {
  let allRecords = []

  const table = new Airtable({apiKey: apiKey}).base(baseId)(tableId)
  table.select().eachPage((pageRecords, fetchNextPage) => {
    allRecords = allRecords.concat(_.map(pageRecords, (record) => { return record._rawJson }))
    setTimeout(fetchNextPage, 500) // API has a limit of 4rpm, wait a little more to be sure
  }, (error) => {
    if (error) {
      done(error, null)
    } else {
      done(null, allRecords)
    }
  })
}

function attachmentsFromRecords (records) {
  const attachments = _.map(records, (record) => {
    return _.map(record.fields, (field) => {
      if (_.isArray(field) && field[0] && field[0].filename && field[0].url) {
        return _.map(field, (att) => {
          return {
            id: att.id,
            filename: att.filename,
            url: att.url
          }
        })
      } else {
        return []
      }
    })
  })

  return _.compact(_.flattenDeep(attachments))
}

function createDir (path) {
  if (fs.existsSync(path) === false) {
    fs.mkdirSync(path)
  }

  return path
}

function backupAttachments (attachmentsPath, attachments) {
  async.eachLimit(attachments, 10, (attachment, done) => {
    axios.get(attachment.url, {responseType: 'arraybuffer'}).then((download) => {
      const filePath = `${attachmentsPath}/${attachment.id}${path.extname(attachment.filename)}`
      fs.writeFileSync(filePath, download.data)
      done()
    })
  })
}

function backupTable (backupDir, baseId, base, tableId, attachments) {
  tableRecords(base.apiKey, baseId, tableId, (error, records) => {
    const tableName = base.tables[tableId]
    if (error) {
      console.log(`${base.name} ${tableName} ERROR: ${error} ×`)
    } else {
      fs.writeFileSync(`${backupDir}/${tableId}.json`, JSON.stringify(records, undefined, 2))
      console.log(`${base.name} ${tableName} records ✔`)

      if (attachments) {
        const dir = createDir(`${backupDir}/attachments`)
        const attachments = attachmentsFromRecords(records)
        backupAttachments(dir, attachments)
      }
    }
  })
}

function backupBase (baseId, base, attachments = true) {
  createDir('backups')
  createDir(`backups/${baseId}`)

  const dateTime = new Date()
  const backupDir = createDir(`backups/${baseId}/${dateTime.toISOString()}`)

  fs.writeFileSync(`${backupDir}/apiDocs.html`, base.apiDocs)

  _.forEach(base.tables, (tableName, tableId) => {
    backupTable(backupDir, baseId, base, tableId, attachments)
  })
}

function backupBases (email, password) {
  bases(email, password).then((bases) => {
    _.forEach(bases, (base, baseId) => {
      backupBase(baseId, base, true)
    })
  }).catch((error) => {
    console.log(error)
  })
}

module.exports = backupBases
