pipeline {
    agent any
    environment {
        REPO_URL      = "https://github.com/G0kul17/Department-Record-Management-System.git"
        BRANCH        = "Gokul"
        BUILD_VERSION = "${env.BUILD_NUMBER}"
        APP_HOST      = "staging-app-01"
        GATEWAY_HOST  = "staging-gateway-01"
        REMOTE_USER   = "deploy"
    }
    stages {
        stage('Checkout') {
            steps {
                git branch: "${BRANCH}", url: "${REPO_URL}"
            }
        }
        stage('Build Frontend') {
            steps {
                dir('frontend') {
                    sh '''
                        rm -rf node_modules
                        npm install
                        echo "VITE_API_BASE_URL=/api" > .env.production
                        npm run build
                        ls -la dist
                    '''
                }
            }
        }
        stage('Prepare Backend Artifact') {
            steps {
                sh '''
                    rm -rf backend_release
                    mkdir backend_release
                    cp -r backend/. backend_release/
                    echo "Backend artifact prepared:"
                    ls -la backend_release
                '''
            }
        }
        stage('Run Backend Tests') {
            steps {
                dir('backend') {
                    sh '''
                        npm ci
                        npm test
                    '''
                }
            }
            post {
                always {
                    junit allowEmptyResults: true,
                          testResults: 'backend/test-results/junit.xml'
                }
            }
        }
        stage('Deploy Backend') {
            steps {
                sshagent(['drms-ssh']) {
                    sh """
                        ssh ${REMOTE_USER}@${APP_HOST} '
                            set -euxo pipefail
                            mkdir -p /opt/drms/backend/releases/${BUILD_VERSION}
                        '
                        scp -r backend_release/. \
                            ${REMOTE_USER}@${APP_HOST}:/opt/drms/backend/releases/${BUILD_VERSION}/
                        ssh ${REMOTE_USER}@${APP_HOST} '
                            cd /opt/drms/backend/releases/${BUILD_VERSION}
                            # Link shared env
                            ln -sfn /opt/drms/backend/.env .env
                            npm ci --omit=dev
                            # Atomic switch
                            ln -sfn /opt/drms/backend/releases/${BUILD_VERSION} /opt/drms/backend/current
                            cd /opt/drms/backend/current
                            pwd
                            /usr/local/bin/pm2 delete drms && /usr/local/bin/pm2 start src/server.js --name drms
                            pm2 save
                            # Keep only last 5 releases
                            cd /opt/drms/backend/releases
                            ls -1dt */ | tail -n +6 | xargs -r rm -rf
                        '
                    """
                }
            }
        }
        stage('Deploy Frontend') {
            steps {
                sshagent(['drms-ssh']) {
                    sh """
                        ssh ${REMOTE_USER}@${GATEWAY_HOST} '
                            set -euxo pipefail
                            rm -rf /var/www/drms-staging/*
                        '
                        scp -r frontend/dist/. \
                            ${REMOTE_USER}@${GATEWAY_HOST}:/var/www/drms-staging/
                    """
                }
            }
        }
        stage('Basic Validation') {
            steps {
                sh '''
                    sleep 5
                    curl -k -f https://staging.drms.internal/ > /dev/null
                    sleep 5
                    curl -k -f http://192.168.4.15:5000/ > /dev/null
                '''
            }
        }
    }
    post {
        success {
            echo "Deployment successful. Release ${BUILD_VERSION} active."
        }
        failure {
            echo "Deployment failed. Investigate logs immediately."
        }
    }
}
