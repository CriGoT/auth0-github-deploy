import _ from 'lodash';
import Promise from 'bluebird';
import * as constants from './constants';

/*
 * Get database connections.
 */
const getDatabaseConnections = (client, databases) => {
  const databaseNames = databases.map(d => d.name);
  return client.connections.getAll({ strategy: 'auth0' })
    .then(connections => connections.filter(c => databaseNames.indexOf(c.name) > -1));
};

/*
 * Update a database.
 */
const updateDatabase = (progress, client, connections, database) => {
  progress.log(`Processing connection '${database.name}'`);

  const connection = _.find(connections, { name: database.name });
  if (!connection) {
    throw new Error(`Unable to find connection named: '${database.name}'`);
  }

  const options = connection.options || { };
  options.customScripts = { };

  // Reset all scripts.
  constants.DATABASE_SCRIPTS.forEach(script => {
    options.customScripts[script] = null;
  });

  // Set all custom scripts from GitHub.
  database.scripts.forEach((script) => {
    options.customScripts[script.stage] = script.contents;
  });

  progress.connectionsUpdated++;
  progress.log(`Updating database ${connection.id}: ${JSON.stringify(options, null, 2)}`);
  return client.connections.update({ id: connection.id }, { options })
    .then(connectionUpdated => {
      progress.log(`Database ${connection.id} succesfully updated`);
      progress.updatedConnections.push(connection);
      return connectionUpdated;
    });
};

/*
 * Update all databases.
 */
export const updateDatabases = (progress, client, databases) => {
  if (databases.length === 0) {
    return Promise.resolve(true);
  }

  return getDatabaseConnections(client, databases)
    .then(connections =>
      Promise
        .map(databases,
          (database) => updateDatabase(progress, client, connections, database),
          { concurrency: constants.CONCURRENT_CALLS })
        );
};


/*
 * Rollbacks a database to its initial state.
 */
const rollbackDatabase = (progress, client, connection) => {
  progress.log(`Rolling back connection '${connection.name}'`);
  const options = connection.options || { };

  progress.log(`Resetting database ${connection.id}: ${JSON.stringify(options, null, 2)}`);
  return client.connections.update({ id: connection.id }, { options })
    .then(updatedConnection => {
      progress.log(`Database ${connection.id} rolled back`);
      return updatedConnection;
    });
};


/* 
 * Rolbacks all changes made to databases
 */
const rollbackDatabases = (progress, client) => {
  if (!progress.updatedConnections || progress.updatedConnections.length === 0) {
    return Promise.resolve(true);
  }

  return Promise.map(progress.updatedConnections,
    (connection) => rollbackDatabase(progress, client, connection));
};

/*
 * Get all rules in all stages.
 */
const getRules = (client) =>
  Promise.all(constants.RULES_STAGES.map(stage => client.rules.getAll({ stage })))
    .then((...rules) => _.chain(rules)
      .flattenDeep()
      .union()
      .value());

/*
 * Delete a rule.
 */
const deleteRule = (progress, client, rules, existingRule) => {
  const rule = _.find(rules, { name: existingRule.name });
  if (!rule) {
    progress.rulesDeleted++;
  }
  
  progress.log(`Deleting rule ${existingRule.name} (${existingRule.id})`);
  return client.rules.delete({ id: existingRule.id })
    .then(() => {
      progress.log(`Rule ${existingRule.name} succesfully deleted`);
      progress.deletedRules.push(existingRule);
      return;
    });
};

/*
 * Delete all rules.
 */
export const deleteRules = (progress, client, rules) => {
  if (rules.length === 0) {
    return Promise.resolve(true);
  }

  progress.log('Deleting all rules to replace them with the ones existing in the repository...');

  return getRules(client)
    .then(existingRules => {
      progress.log(`Existing rules: ${JSON.stringify(existingRules.map(rule => ({ id: rule.id, name: rule.name, stage: rule.stage, order: rule.order })), null, 2)}`);
      return Promise.map(existingRules, (rule) => deleteRule(progress, client, rules, rule), { concurrency: constants.CONCURRENT_CALLS });
    });
};

/*
 * Update a single rule.
 */
const updateRule = (progress, client, existingRules, ruleName, ruleData) => {
  progress.log(`Processing rule '${ruleName}'`);

  const rule = _.find(existingRules, { name: ruleName });
  const payload = {
    enabled: true,
    stage: 'login_success',
    ...ruleData.metadata,
    name: ruleName,
    script: ruleData.script
  };

  if (!rule) {
    // New rule
    progress.rulesCreated++;
    progress.log(`Creating rule ${ruleName}: ${JSON.stringify(payload, null, 2)}`);
  } else {
    // Rule already existed.
    progress.rulesUpdated++;
    progress.log(`Updating rule ${ruleName}: ${JSON.stringify(payload, null, 2)}`);
  }
  
  return client.rules.create(payload);
};

/*
 * Update all rules.
 */
export const updateRules = (progress, client, rules) => {
  if (rules.length === 0) {
    return Promise.resolve(true);
  }

  progress.log('Updating rules...');

  return Promise.map(rules, 
    (rule) => updateRule(progress, client, progress.deletedRules, rule.name, rule),
    { concurrency: constants.CONCURRENT_CALLS });
};

/*
 * Restores a rule deleted during deployment
 */
const rollbackRule = (progress, client, rule) => {
  progress.log(`Rolling back rule '${rule.name}'`);
  delete rule.id;

  return client.rules.create(rule);
}

/*
 * Rollback all changes applied to rules in the tenant
 */
const rollbackRules = (progress, client) => {
  progress.log('Attempting to rollback changes in rules');

  return getRules(client)
    .then(existingRules => {
      if (existingRules.length === 0 ) {
        return Promise.resolve();
      }

      progress.log(`Removing all ${existingRules.length} deployed rules`);
      return Promise.map(existingRules, 
        (rule) => client.rules.delete({ id: rule.id }),
        { concurrency: constants.CONCURRENT_CALLS });
      })
      .then(() => Promise.map(progress.deletedRules,
        (rule) => rollbackRule(progress, client, rule),
        { concurrency: constants.CONCURRENT_CALLS }
      ));
};

export const rollbackProgress = (progress, client, err) => {
  if (err) progress.log(`An error ocurred: ${err.message}`);

  progress.log('Trying to rollback changes made during the deployment');

  return rollbackDatabases(progress, client)
    .then(()=> rollbackRules(progress, client))
    .then(
      () => {
        progress.log('Rollback completed succesfully');
        delete progress.updatedConnections;
        delete progress.deletedRules;
        if (err) throw err;
      }, 
      (errRollback)=> {
        progress.log(`Rollback could not be completed. ${errRollback}`);
        if (err) throw err;
      });
}
