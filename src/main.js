const artifact = require('@actions/artifact');
const core = require('@actions/core');
const exec = require('@actions/exec');
const github = require('@actions/github');
const glob = require('@actions/glob');
const lcovTotal = require("lcov-total");
const os = require('os');
const path = require('path');

async function run() {
  try {
    await exec.exec('sudo apt-get install -y lcov');

    const tmpPath = path.resolve(os.tmpdir(), github.context.action);
    const coverageFilesPattern = core.getInput('coverage-files');
    const globber = await glob.create(coverageFilesPattern);
    const coverageFiles = await globber.glob();

    await genhtml(coverageFiles, tmpPath);

    const coverageFile = await mergeCoverages(coverageFiles, tmpPath);
    const totalCoverage = lcovTotal(coverageFile);
    const minimumCoverage = core.getInput('minimum-coverage');
    const gitHubToken = core.getInput('github-token').trim();
    const errorMessage = `The code coverage is too low. Expected at least ${minimumCoverage}.`;
    const isFailure = totalCoverage < minimumCoverage;

    if (gitHubToken !== '') {
      const octokit = await github.getOctokit(gitHubToken);
      const summary = await summarize(coverageFile);
      const details = await detail(coverageFile, octokit);
      
      const options = {
		    repository: github.context.payload.repository.full_name,
	    }
      
      if (github.context.eventName === "pull_request") {
	    	options.commit = github.context.payload.pull_request.head.sha
	    	options.head = github.context.payload.pull_request.head.ref
	    	options.base = github.context.payload.pull_request.base.ref
      } else if (github.context.eventName === "push") {
		    options.commit = github.context.payload.after
		    options.head = github.context.ref
      }
      
      const sha = options.commit
      const shaShort = options.commit.substr(0, 7);
	    
      if (github.context.eventName === "pull_request") {
        
        core.info("Creating a comment in the PR.")
        
        let body = `### [LCOV](https://github.com/immel-f/github-actions-report-lcov) of commit [<code>${shaShort}</code>](${github.context.payload.pull_request.number}/commits/${sha}) during [${github.context.workflow} #${github.context.runNumber}](../actions/runs/${github.context.runId})\n<pre>${summary}</pre>\n<details><summary>File coverage rate:</summary><pre>${details}</pre></details>`;

        if (isFailure) {
          body += `\n:no_entry: ${errorMessage}`;
        }
	      
        try {
          await octokit.issues.createComment({
			      repo: github.context.repo.repo,
			      owner: github.context.repo.owner,
			      issue_number: github.context.payload.pull_request.number,
			      body: body,
		      })
        } catch (error) {
          core.info("Error while trying to write a comment in the PR. This may be caused by insufficient permissions of the action.")
        }
	      
      } else if (github.context.eventName === "push") {
        
        core.info("Creating a comment in the Commit.")
        
        let body = `### [LCOV](https://github.com/immel-f/github-actions-report-lcov) of commit [<code>${shaShort}</code>] during [${github.context.workflow} #${github.context.runNumber}](../actions/runs/${github.context.runId})\n<pre>${summary}</pre>\n<details><summary>File coverage rate:</summary><pre>${details}</pre></details>`;

        if (isFailure) {
          body += `\n:no_entry: ${errorMessage}`;
        }
	      
        try {
          await octokit.repos.createCommitComment({
			      repo: github.context.repo.repo,
			      owner: github.context.repo.owner,
			      commit_sha: options.commit,
			      body: body,
		      })
        } catch (error) {
          core.info("Error while trying to write a comment in the commit. This may be caused by insufficient permissions of the action.")
        }
      	}
      } else {
	      
      core.info("github-token received is empty. Skipping writing a comment.");
      core.info("Note: This could happen even if github-token was provided in workflow file. It could be because your github token does not have permissions for commenting in target repo.")
      }

    if (isFailure) {
      throw Error(errorMessage);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

async function genhtml(coverageFiles, tmpPath) {
  const workingDirectory = core.getInput('working-directory').trim() || './';
  const artifactName = core.getInput('artifact-name').trim();
  const artifactPath = path.resolve(tmpPath, 'html').trim();
  const args = [...coverageFiles, '--rc', 'lcov_branch_coverage=1', '--no-source', '--synthesize-missing'];

  args.push('--output-directory');
  args.push(artifactPath);

  await exec.exec('genhtml', args, { cwd: workingDirectory });

  if (artifactName !== '') {
    const globber = await glob.create(`${artifactPath}/**`);
    const htmlFiles = await globber.glob();

    core.info(`Uploading artifacts.`);

    await artifact
      .create()
      .uploadArtifact(
        artifactName,
        htmlFiles,
        artifactPath,
        { continueOnError: false },
      );
  } else {
    core.info("Skip uploading artifacts");
  }
}

async function mergeCoverages(coverageFiles, tmpPath) {
  // This is broken for some reason:
  //const mergedCoverageFile = path.resolve(tmpPath, 'lcov.info');
  const mergedCoverageFile = tmpPath + '/lcov.info';
  const args = [];

  for (const coverageFile of coverageFiles) {
    args.push('--add-tracefile');
    args.push(coverageFile);
  }

  args.push('--output-file');
  args.push(mergedCoverageFile);

  await exec.exec('lcov', [...args, '--rc', 'lcov_branch_coverage=1']);

  return mergedCoverageFile;
}

async function summarize(coverageFile) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--summary',
    coverageFile,
    '--rc',
    'lcov_branch_coverage=1'
  ], options);

  const lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."

  return lines.join('\n');
}

async function detail(coverageFile, octokit) {
  let output = '';

  const options = {};
  options.listeners = {
    stdout: (data) => {
      output += data.toString();
    },
    stderr: (data) => {
      output += data.toString();
    }
  };

  await exec.exec('lcov', [
    '--list',
    coverageFile,
    '--list-full-path',
    '--rc',
    'lcov_branch_coverage=1',
  ], options);

  let lines = output
    .trim()
    .split(/\r?\n/)

  lines.shift(); // Removes "Reading tracefile..."
  lines.pop(); // Removes "Total..."
  lines.pop(); // Removes "========"

  if (github.context.eventName === "pull_request") {
    const listFilesOptions = octokit
      .pulls.listFiles.endpoint.merge({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: github.context.payload.pull_request.number,
      });
    const listFilesResponse = await octokit.paginate(listFilesOptions);
    const changedFiles = listFilesResponse.map(file => file.filename);

    lines = lines.filter((line, index) => {
      if (index <= 2) return true; // Include header

      for (const changedFile of changedFiles) {
        console.log(`${line} === ${changedFile}`);

        if (line.startsWith(changedFile)) return true;
      }

      return false;
    });

    if (lines.length === 3) { // Only the header remains
      return ' n/a';
    }

    return '\n  ' + lines.join('\n  ');
  }
  
  return '\n  ' + lines.join('\n  ');
}

run();
