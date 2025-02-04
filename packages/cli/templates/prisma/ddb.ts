import {
  CreateTableCommand,
  CreateTableCommandInput,
  DescribeContinuousBackupsCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  DynamoDBClient,
  ResourceNotFoundException,
  UpdateContinuousBackupsCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb'
import dotenv from 'dotenv'
import { readFileSync, readdirSync } from 'fs'
import path from 'path'

dotenv.config()

const tableDir = path.join(__dirname, 'dynamodbs')
const cqrsModuleFname = 'cqrs.json'
const cqrsTableDecsFname = 'cqrs_desc.json'

const tablePrefix = `${process.env.NODE_ENV}-${process.env.APP_NAME}-`

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: process.env.DYNAMODB_REGION,
})

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

let cnt = 0

async function main() {
  // create cqrs tables
  await createCqrsTables()
  // create other tables
  await Promise.all(
    readdirSync(tableDir)
      .filter(
        (fname) => fname !== cqrsModuleFname && fname !== cqrsTableDecsFname,
      )
      .map((fname) =>
        createTable(
          JSON.parse(readFileSync(path.join(tableDir, fname)).toString()),
        ),
      ),
  )
  if (cnt) {
    console.log('\n' + cnt + ' tables were created successfully')
  } else {
    console.log('\nNo tables were created')
  }
}

async function createCqrsTables() {
  const cqrsModules: string[] =
    JSON.parse(readFileSync(path.join(tableDir, cqrsModuleFname)).toString()) ||
    []
  const desc: CreateTableCommandInput = JSON.parse(
    readFileSync(path.join(tableDir, cqrsTableDecsFname)).toString(),
  )

  for (const name of cqrsModules) {
    const cmdDesc = { ...desc, TableName: name + '-command' }
    const dataDecs = {
      ...cmdDesc,
      StreamSpecification: undefined,
      TableName: name + '-data',
    }
    const historyDesc = { ...dataDecs, TableName: name + '-history' }
    await Promise.all([cmdDesc, dataDecs, historyDesc].map(createTable))
  }
}

async function createTable(config: CreateTableCommandInput) {
  // add table prefix
  config.TableName = tablePrefix + config.TableName

  // check table is already created
  try {
    const tableDesc = await client.send(
      new DescribeTableCommand({ TableName: config.TableName }),
    )
    if (tableDesc.Table?.TableArn) {
      console.log(
        'table exists:',
        tableDesc.Table.TableArn,
        ' => stream:',
        tableDesc.Table.LatestStreamArn,
      )

      await updateTable(config.TableName)

      return tableDesc.Table.TableArn
    }
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) {
      throw error
    }
  }

  // create table
  const table = await client.send(new CreateTableCommand(config))
  if (table.TableDescription?.TableArn) {
    console.log(
      'table created with arn: `',
      table.TableDescription?.TableArn,
      '`, and stream arn:`',
      table.TableDescription?.LatestStreamArn,
      '`',
    )
    cnt++
  }
  return table.TableDescription?.TableArn
}

async function updateTable(TableName: string) {
  try {
    // Time to live
    const ttlDesc = await client.send(
      new DescribeTimeToLiveCommand({ TableName }),
    )
    if (ttlDesc.TimeToLiveDescription?.TimeToLiveStatus === 'DISABLED') {
      console.log('enable time to live for table:', TableName)

      await client.send(
        new UpdateTimeToLiveCommand({
          TableName,
          TimeToLiveSpecification: {
            Enabled: true,
            AttributeName: 'ttl',
          },
        }),
      )
    }

    // Point-in-time recovery for production
    if (process.env.NODE_ENV === 'prod') {
      const pitDesc = await client.send(
        new DescribeContinuousBackupsCommand({ TableName }),
      )
      if (
        pitDesc.ContinuousBackupsDescription?.ContinuousBackupsStatus ===
        'DISABLED'
      ) {
        console.log('enable point-in-time recovery for table:', TableName)

        await client.send(
          new UpdateContinuousBackupsCommand({
            TableName,
            PointInTimeRecoverySpecification: {
              PointInTimeRecoveryEnabled: true,
            },
          }),
        )
      }
    }
  } catch (error) {
    console.error(error)
  }
}
