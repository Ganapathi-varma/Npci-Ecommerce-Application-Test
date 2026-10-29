// Phase 1 - CI pipeline: install -> unit tests -> Docker image build -> vulnerability scan.
// Requirements on the Jenkins agent: Node.js >= 18.13, Google Chrome, Docker (the jenkins user
// must be in the `docker` group). No credentials are needed for these stages.

def stageResults = [:]   // stage name -> SUCCESS | FAILURE, written to ci-status.json for the incident agent

pipeline {
    agent any

    options {
        timestamps()
        timeout(time: 30, unit: 'MINUTES')
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20', artifactNumToKeepStr: '10'))
    }

    parameters {
        string(name: 'GIT_REPO_URL', defaultValue: 'https://github.com/Ganapathi-varma/Npci-Ecommerce-Application-Test.git',
               description: 'Only used when the job is a plain "Pipeline script" (no SCM); ignored for Pipeline from SCM / Multibranch')
        string(name: 'GIT_BRANCH_NAME', defaultValue: 'main',
               description: 'Branch to build when the job has no SCM configured')
        string(name: 'SCAN_SEVERITY', defaultValue: 'HIGH,CRITICAL',
               description: 'Trivy severities that fail the build')
        booleanParam(name: 'FAIL_ON_VULN', defaultValue: true,
                     description: 'Fail the build when fixable vulnerabilities of the severities above are found')
    }

    environment {
        APP_NAME     = 'npci-ecommerce-frontend'
        TRIVY_IMAGE  = 'aquasec/trivy:0.58.1'
        CHROME_BIN   = '/usr/bin/google-chrome'
        CI           = 'true'
        NG_CLI_ANALYTICS = 'false'
        NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    }

    stages {

        stage('Checkout') {
            steps {
                script {
                    // Works for "Pipeline script from SCM" / Multibranch; falls back to an explicit
                    // checkout when the Jenkinsfile was pasted into a plain "Pipeline script" job.
                    try {
                        checkout scm
                    } catch (Exception e) {
                        echo "No job SCM available (${e.message}); checking out ${params.GIT_REPO_URL}@${params.GIT_BRANCH_NAME}"
                        checkout([$class: 'GitSCM',
                                  branches: [[name: "*/${params.GIT_BRANCH_NAME}"]],
                                  userRemoteConfigs: [[url: params.GIT_REPO_URL]]])
                    }
                    env.GIT_COMMIT = sh(script: 'git rev-parse HEAD', returnStdout: true).trim()
                    env.GIT_SHORT = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.IMAGE_TAG = "${env.BUILD_NUMBER}-${env.GIT_SHORT}"
                    env.IMAGE     = "${env.APP_NAME}:${env.IMAGE_TAG}"
                }
                sh 'node -v && npm -v && docker --version && "$CHROME_BIN" --version'
            }
            post {
                success { script { stageResults['Checkout'] = 'SUCCESS' } }
                failure { script { stageResults['Checkout'] = 'FAILURE' } }
            }
        }

        stage('Install') {
            steps {
                // `npm ci` needs a lockfile; fall back so the pipeline still works until one is committed
                sh '''
                    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund
                    else echo "WARN: package-lock.json missing, using npm install"; npm install --no-audit --no-fund
                    fi
                '''
            }
            post {
                success { script { stageResults['Install'] = 'SUCCESS' } }
                failure { script { stageResults['Install'] = 'FAILURE' } }
            }
        }

        stage('Unit Tests') {
            steps {
                sh 'npx ng test --watch=false --browsers=ChromeHeadlessCI --karma-config=ci/karma.ci.conf.js --code-coverage'
            }
            post {
                always  { archiveArtifacts artifacts: 'coverage/**', allowEmptyArchive: true }
                success { script { stageResults['Unit Tests'] = 'SUCCESS' } }
                failure { script { stageResults['Unit Tests'] = 'FAILURE' } }
            }
        }

        stage('Docker Build') {
            steps {
                // The multi-stage Dockerfile compiles the Angular app itself; no secrets are passed in.
                sh '''
                    DOCKER_BUILDKIT=1 docker build --pull \
                        --build-arg OS_UPDATE_DATE="$(date +%F)" \
                        --label org.opencontainers.image.revision="$GIT_COMMIT" \
                        --label ci.build-number="$BUILD_NUMBER" \
                        -t "$IMAGE" -t "$APP_NAME:latest" .
                    docker images "$APP_NAME"
                '''
            }
            post {
                success { script { stageResults['Docker Build'] = 'SUCCESS' } }
                failure { script { stageResults['Docker Build'] = 'FAILURE' } }
            }
        }

        stage('Vulnerability Scan') {
            steps {
                sh '''
                    mkdir -p reports
                    TRIVY="docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v trivy-cache:/root/.cache/ -v $WORKSPACE/reports:/reports $TRIVY_IMAGE"

                    # Full reports (never fail) - kept as build artifacts for review and for the diagnosis agent
                    $TRIVY image --scanners vuln --format json  --output /reports/trivy-report.json "$IMAGE"
                    $TRIVY image --scanners vuln --format table --output /reports/trivy-report.txt  "$IMAGE"
                    cat reports/trivy-report.txt

                    # Gate: fixable issues at the chosen severities fail the build
                    EXIT=0; [ "$FAIL_ON_VULN" = "true" ] && EXIT=1
                    $TRIVY image --scanners vuln --severity "$SCAN_SEVERITY" --ignore-unfixed --exit-code $EXIT "$IMAGE"
                '''
            }
            post {
                always  { archiveArtifacts artifacts: 'reports/trivy-report.*', allowEmptyArchive: true }
                success { script { stageResults['Vulnerability Scan'] = 'SUCCESS' } }
                failure { script { stageResults['Vulnerability Scan'] = 'FAILURE' } }
            }
        }
    }

    post {
        always {
            // Machine-readable CI status: one of the inputs for the AI incident-diagnosis agent
            script {
                def stagesJson = stageResults.collect { k, v -> "\"${k}\": \"${v}\"" }.join(', ')
                writeFile file: 'ci-status.json', text: """{
  "job": "${env.JOB_NAME}",
  "build_number": ${env.BUILD_NUMBER},
  "result": "${currentBuild.currentResult}",
  "commit": "${env.GIT_SHORT ?: 'unknown'}",
  "image": "${env.IMAGE ?: ''}",
  "duration_ms": ${currentBuild.duration},
  "build_url": "${env.BUILD_URL}",
  "stages": { ${stagesJson} }
}
"""
            }
            archiveArtifacts artifacts: 'ci-status.json', allowEmptyArchive: true
        }
        success { echo "CI passed. Image ${env.IMAGE} is ready for the deploy phase." }
        failure { echo 'CI failed. See the failing stage log and ci-status.json.' }
    }
}
