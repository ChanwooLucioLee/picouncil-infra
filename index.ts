import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import { execSync } from 'child_process'

const config = new pulumi.Config()

// =============================================================================
// Configuration
// =============================================================================
const ECR_REGISTRY = '066047414165.dkr.ecr.ap-northeast-2.amazonaws.com'
const AWS_REGION = 'ap-northeast-2'
const environment = 'production'

// =============================================================================
// Image Tag Strategy (Git commit hash for immutable tags)
// =============================================================================
function verifyEcrImageExists(repo: string, tag: string): void {
  try {
    execSync(
      `aws ecr describe-images --repository-name ${repo} --image-ids imageTag=${tag} --region ${AWS_REGION}`,
      { encoding: 'utf-8', stdio: 'pipe' }
    )
    console.log(`✓ ECR image verified: ${repo}:${tag}`)
  } catch {
    console.log(`⚠ ECR image not found: ${repo}:${tag} - will be created on first deploy`)
  }
}

function getGitCommit(projectPath: string): string {
  try {
    const commit = execSync(`git -C ${projectPath} rev-parse --short HEAD`, {
      encoding: 'utf-8',
    }).trim()
    return commit
  } catch {
    return 'latest'
  }
}

const serverCommit = getGitCommit('../picouncil-server')
const serverImage =
  config.get('serverImage') || `${ECR_REGISTRY}/picouncil-server:${serverCommit}`

console.log(`Server image: ${serverImage}`)
verifyEcrImageExists('picouncil-server', serverCommit)

// =============================================================================
// VPC (Simple setup - single public subnet)
// =============================================================================
const vpc = new aws.ec2.Vpc('picouncil-vpc', {
  cidrBlock: '10.0.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: { Name: 'picouncil-vpc' },
})

const subnet = new aws.ec2.Subnet('picouncil-subnet', {
  vpcId: vpc.id,
  cidrBlock: '10.0.1.0/24',
  availabilityZone: `${AWS_REGION}a`,
  mapPublicIpOnLaunch: true,
  tags: { Name: 'picouncil-subnet' },
})

const internetGateway = new aws.ec2.InternetGateway('picouncil-igw', {
  vpcId: vpc.id,
  tags: { Name: 'picouncil-igw' },
})

const routeTable = new aws.ec2.RouteTable('picouncil-rt', {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      gatewayId: internetGateway.id,
    },
  ],
  tags: { Name: 'picouncil-rt' },
})

new aws.ec2.RouteTableAssociation('picouncil-rt-assoc', {
  subnetId: subnet.id,
  routeTableId: routeTable.id,
})

// Security Group (SSH only - Cloudflare Tunnel handles HTTPS)
const securityGroup = new aws.ec2.SecurityGroup('picouncil-sg', {
  description: 'Security group for PICouncil ECS',
  vpcId: vpc.id,
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'SSH',
    },
  ],
  egress: [
    {
      protocol: '-1',
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ['0.0.0.0/0'],
      description: 'All outbound',
    },
  ],
  tags: { Name: 'picouncil-sg' },
})

// =============================================================================
// IAM Roles
// =============================================================================
const ecsInstanceRole = new aws.iam.Role('picouncil-ecs-instance-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ec2.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  }),
})

new aws.iam.RolePolicyAttachment('picouncil-ecs-instance-ecs', {
  role: ecsInstanceRole.name,
  policyArn:
    'arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role',
})

new aws.iam.RolePolicyAttachment('picouncil-ecs-instance-ssm', {
  role: ecsInstanceRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
})

const ecsInstanceProfile = new aws.iam.InstanceProfile(
  'picouncil-ecs-instance-profile',
  {
    role: ecsInstanceRole.name,
  }
)

const ecsTaskExecutionRole = new aws.iam.Role('picouncil-task-execution-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
      },
    ],
  }),
})

new aws.iam.RolePolicyAttachment('picouncil-task-execution-ecs', {
  role: ecsTaskExecutionRole.name,
  policyArn:
    'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
})

new aws.iam.RolePolicyAttachment('picouncil-task-execution-ecr', {
  role: ecsTaskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly',
})

// SSM Parameter access
const awsAccountId = aws.getCallerIdentity().then((id) => id.accountId)

new aws.iam.RolePolicy('picouncil-task-execution-ssm', {
  role: ecsTaskExecutionRole.name,
  policy: awsAccountId.then((accountId) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: ['ssm:GetParameters', 'ssm:GetParameter'],
          Resource: `arn:aws:ssm:${AWS_REGION}:${accountId}:parameter/picouncil/*`,
        },
      ],
    })
  ),
})

// =============================================================================
// SSM Parameters (Secrets)
// =============================================================================
const secretNames = ['DATABASE_URL', 'JWT_SECRET']

for (const secret of secretNames) {
  const configKey = secret.toLowerCase().replace(/_/g, '-')
  const secretValue = config.getSecret(configKey)
  if (secretValue) {
    new aws.ssm.Parameter(`picouncil-${secret}`, {
      name: `/picouncil/${secret}`,
      type: 'SecureString',
      value: secretValue,
      tags: { Environment: environment },
    })
  }
}

// =============================================================================
// ECR Repository
// =============================================================================
const ecrRepository = new aws.ecr.Repository('picouncil-server', {
  name: 'picouncil-server',
  imageTagMutability: 'MUTABLE',
  imageScanningConfiguration: {
    scanOnPush: true,
  },
  tags: { Name: 'picouncil-server' },
})

new aws.ecr.LifecyclePolicy('picouncil-server-lifecycle', {
  repository: ecrRepository.name,
  policy: JSON.stringify({
    rules: [
      {
        rulePriority: 1,
        description: 'Keep last 10 images',
        selection: {
          tagStatus: 'any',
          countType: 'imageCountMoreThan',
          countNumber: 10,
        },
        action: {
          type: 'expire',
        },
      },
    ],
  }),
})

// =============================================================================
// CloudWatch Log Group
// =============================================================================
const logGroup = new aws.cloudwatch.LogGroup('picouncil-logs', {
  name: '/ecs/picouncil-server',
  retentionInDays: 14,
})

// =============================================================================
// ECS Cluster
// =============================================================================
const ecsCluster = new aws.ecs.Cluster('picouncil-cluster', {
  name: 'picouncil-cluster',
  settings: [{ name: 'containerInsights', value: 'disabled' }],
})

// =============================================================================
// ECS Task Definition
// =============================================================================
const taskDefinition = new aws.ecs.TaskDefinition('picouncil-server-task', {
  family: 'picouncil-server',
  networkMode: 'bridge',
  requiresCompatibilities: ['EC2'],
  executionRoleArn: ecsTaskExecutionRole.arn,
  containerDefinitions: logGroup.name.apply((logGroupName) =>
    JSON.stringify([
      {
        name: 'picouncil-server',
        image: serverImage,
        essential: true,
        memory: 384,
        cpu: 256,
        portMappings: [
          {
            containerPort: 8080,
            hostPort: 8080,
            protocol: 'tcp',
          },
        ],
        environment: [
          { name: 'PORT', value: '8080' },
          { name: 'ENVIRONMENT', value: 'production' },
          { name: 'FRONTEND_URL', value: 'https://picouncil.com' },
        ],
        secrets: [
          {
            name: 'DATABASE_URL',
            valueFrom: `/picouncil/DATABASE_URL`,
          },
          {
            name: 'JWT_SECRET',
            valueFrom: `/picouncil/JWT_SECRET`,
          },
        ],
        logConfiguration: {
          logDriver: 'awslogs',
          options: {
            'awslogs-group': logGroupName,
            'awslogs-region': AWS_REGION,
            'awslogs-stream-prefix': 'ecs',
          },
        },
        healthCheck: {
          command: [
            'CMD-SHELL',
            'wget -q --spider http://localhost:8080/health || exit 1',
          ],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
      },
    ])
  ),
  tags: { Name: 'picouncil-server-task' },
})

// =============================================================================
// EC2 Instance (ECS-optimized AMI for ARM - cost effective)
// =============================================================================
const instanceType = config.get('instanceType') || 't4g.micro'

// Cloudflare Tunnel token (set via: pulumi config set --secret cloudflareTunnelToken xxx)
const tunnelToken = config.getSecret('cloudflareTunnelToken') || ''

const ecsAmi = aws.ssm
  .getParameter({
    name: '/aws/service/ecs/optimized-ami/amazon-linux-2023/arm64/recommended/image_id',
  })
  .then((p) => p.value)

const userData = pulumi
  .all([ecsCluster.name, tunnelToken])
  .apply(([clusterName, token]) =>
    Buffer.from(
      `#!/bin/bash
# Configure ECS agent
echo ECS_CLUSTER=${clusterName} >> /etc/ecs/ecs.config

# Install cloudflared (ARM64) if token provided
if [ -n "${token}" ]; then
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
  chmod +x /usr/local/bin/cloudflared

  cat > /etc/systemd/system/cloudflared.service << EOF
[Unit]
Description=Cloudflare Tunnel
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/cloudflared tunnel --no-autoupdate run --token ${token}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable cloudflared
  systemctl start cloudflared
fi
`
    ).toString('base64')
  )

const ecsInstance = new aws.ec2.Instance('picouncil-ecs-instance', {
  ami: ecsAmi,
  instanceType: instanceType,
  iamInstanceProfile: ecsInstanceProfile.name,
  subnetId: subnet.id,
  vpcSecurityGroupIds: [securityGroup.id],
  userData: userData,
  associatePublicIpAddress: true,
  rootBlockDevice: {
    volumeSize: 30,
    volumeType: 'gp3',
  },
  tags: { Name: 'picouncil-ecs-instance' },
})

// =============================================================================
// ECS Service
// =============================================================================
const ecsService = new aws.ecs.Service('picouncil-server-service', {
  name: 'picouncil-server',
  cluster: ecsCluster.arn,
  taskDefinition: taskDefinition.arn,
  desiredCount: 1,
  launchType: 'EC2',
  deploymentMinimumHealthyPercent: 0,
  deploymentMaximumPercent: 100,
  tags: { Name: 'picouncil-server-service' },
})

// =============================================================================
// S3 Bucket (File Storage)
// =============================================================================
const filesBucket = new aws.s3.BucketV2('picouncil-files', {
  bucket: 'picouncil-files',
  tags: { Name: 'picouncil-files' },
})

new aws.s3.BucketPublicAccessBlock('picouncil-files-public-access', {
  bucket: filesBucket.id,
  blockPublicAcls: true,
  blockPublicPolicy: true,
  ignorePublicAcls: true,
  restrictPublicBuckets: true,
})

// =============================================================================
// Outputs
// =============================================================================
export const vpcId = vpc.id
export const ecrRepositoryUrl = ecrRepository.repositoryUrl
export const ecsClusterArn = ecsCluster.arn
export const instancePublicIp = ecsInstance.publicIp
export const filesBucketName = filesBucket.id
