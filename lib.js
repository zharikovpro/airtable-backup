const Promise = require('prfun')
const _ = require('lodash')
const axios = require('axios')
require('@3846masa/axios-cookiejar-support')(axios)
const tough = require('tough-cookie')
const Airtable = require('airtable')
const fs = require('fs')
const path = require('path')
const async = require('async')

async function bases(email, password, api_info = true) {
  const base_url = 'https://airtable.com'

  // cookies are required for the authentication to work
  const request_with_cookies = axios.create({
    jar: new tough.CookieJar(),
    withCredentials: true
  });

  const login_form = await request_with_cookies.get(`${base_url}/login`)
  const _csrf = login_form.data.match(/name="_csrf"\s*value="(\S*)"/)[1]

  const session = await request_with_cookies.post(`${base_url}/auth/login`, {_csrf, email, password})
  if (session.data.indexOf('redirectAfterSuccessfulLogin') === -1) {
    throw 'NotLoggedIn'
  }

  const app = await request_with_cookies.get(`${base_url}/auth/redirectAfterSuccessfulLogin`)
  const init_data = JSON.parse(app.data.match(/initData.+?({.*})/)[1])

  let bases = _.mapValues(init_data['rawApplications'], (app) => {
    return {
      name: app['name'],
      tables: _.fromPairs(_.map(app['visibleTableOrder'], (table_id) => {
        return [table_id, init_data.rawTables[table_id].name]
      }))
    }
  })

  if (api_info) {
    bases = await Promise.props(_.mapValues(bases, async (base, base_id) => {
      const api_docs = await request_with_cookies.get(`${base_url}/${base_id}/api/docs#curl/introduction`)
      const api_key = api_docs.data.match(/data-api-key="(\S*)"/)[1]

      return _.merge(base, {
        api_docs: api_docs.data,
        api_key: api_key
      })
    }))
  }

  return bases
}

function table_records(api_key, base_id, table_id, done) {
  let all_records = []

  const table = new Airtable({apiKey: api_key}).base(base_id)(table_id)
  table.select().eachPage(function page(page_records, fetchNextPage) {
    all_records = all_records.concat(_.map(page_records, (record) => { return record._rawJson }))
    setTimeout(fetchNextPage, 500) // API has a limit of 4rpm, wait a little more to be sure
  }, (error) => {
    if (error) {
      done(error, null)
    } else {
      done(null, all_records)
    }
  })
}

function attachments_from_records(records) {
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

function create_dir(path) {
  if (fs.existsSync(path) === false) {
    fs.mkdirSync(path)
  }

  return path
}

function backup_attachments(attachments_path, attachments) {
  async.eachLimit(attachments, 10, (attachment, done) => {
    axios.get(attachment.url, {responseType: 'arraybuffer'}).then((download) => {
      const file_path = `${attachments_path}/${attachment.id}${path.extname(attachment.filename)}`
      fs.writeFileSync(file_path, download.data)
      done()
    })
  })
}

function backup_table(backup_dir, base_id, base, table_id, attachments) {
  table_records(base.api_key, base_id, table_id, (error, records) => {
    const table_name = base.tables[table_id]
    if (error) {
      console.log(`${base.name} ${table_name} ERROR: ${error} ×`)
    } else {
      fs.writeFileSync(`${backup_dir}/${table_id}.json`, JSON.stringify(records, undefined, 2))
      console.log(`${base.name} ${table_name} records ✔`)

      if (attachments) {
        const dir = create_dir(`${backup_dir}/attachments`)
        const attachments = attachments_from_records(records)
        backup_attachments(dir, attachments)
      }
    }
  })
}

function backup_base(base_id, base, attachments = true) {
  create_dir('backups')
  create_dir(`backups/${base_id}`)

  const date_time = new Date()
  const backup_dir = create_dir(`backups/${base_id}/${date_time.toISOString()}`)

  fs.writeFileSync(`${backup_dir}/api_docs.html`, base.api_docs)

  _.forEach(base.tables, (table_name, table_id) => {
    backup_table(backup_dir, base_id, base, table_id, attachments)
  })
}

function backup_bases(email, password) {
  bases(email, password).then((bases) => {
    _.forEach(bases, (base, base_id) => {
      backup_base(base_id, base, true)
    })
  }).catch((error) => {
    console.log(error)
  })
}

module.exports = backup_bases
