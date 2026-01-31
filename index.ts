import * as pulumi from '@pulumi/pulumi'
import * as aws from '@pulumi/aws'
import * as cloudflare from '@pulumi/cloudflare'
import { execSync } from 'child_process'

const config = new pulumi.Config()

// =============================================================================
// Configuration
// =============================================================================
const AWS_REGION = 'ap-northeast-2'
const DOMAIN = 'picouncil.com' // Update when domain is registered
const ECR_REGISTRY = `${aws.getCallerIdentityOutput().accountId}.dkr.ecr.${AWS_REGION}.amazonaws.com`

// Get git commit for image tags
function getGitCommit(projectPath: string): string {
  try {
    const commit = execSync(`git -C ${projectPath} rev-parse --short HEAD`, {
      encoding: 'utf-8',
    }).trim()
    return commit
  } catch {
    try {
      return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    } catch {
      return 'latest'
    }
  }
}

const serverCommit = getGitCommit('../picouncil-server')
const adminCommit = getGitCommit('../picouncil-admin')
const serverImage = config.get('serverImage') || `${ECR_REGISTRY}/picouncil-server:${serverCommit}`
const adminImage = config.get('adminImage') || `${ECR_REGISTRY}/picouncil-admin:${adminCommit}`

console.log(`Deploying picouncil-server image: ${serverImage}`)
console.log(`Deploying picouncil-admin image: ${adminImage}`)

// =============================================================================
// VPC
// =============================================================================
const vpc = new aws.ec2.Vpc('picouncil-vpc', {
  cidrBlock: '10.0.0.0/16',
  enableDnsHostnames: true,
  enableDnsSupport: true,
  tags: { Name: 'picouncil-vpc' },
})

// Public Subnets (for ALB)
const publicSubnetA = new aws.ec2.Subnet('picouncil-public-a', {
  vpcId: vpc.id,
  cidrBlock: '10.0.1.0/24',
  availabilityZone: `${AWS_REGION}a`,
  mapPublicIpOnLaunch: true,
  tags: { Name: 'picouncil-public-a' },
})

const publicSubnetB = new aws.ec2.Subnet('picouncil-public-b', {
  vpcId: vpc.id,
  cidrBlock: '10.0.2.0/24',
  availabilityZone: `${AWS_REGION}b`,
  mapPublicIpOnLaunch: true,
  tags: { Name: 'picouncil-public-b' },
})

// Private Subnets (for ECS, RDS)
const privateSubnetA = new aws.ec2.Subnet('picouncil-private-a', {
  vpcId: vpc.id,
  cidrBlock: '10.0.10.0/24',
  availabilityZone: `${AWS_REGION}a`,
  tags: { Name: 'picouncil-private-a' },
})

const privateSubnetB = new aws.ec2.Subnet('picouncil-private-b', {
  vpcId: vpc.id,
  cidrBlock: '10.0.11.0/24',
  availabilityZone: `${AWS_REGION}b`,
  tags: { Name: 'picouncil-private-b' },
})

// Internet Gateway
const igw = new aws.ec2.InternetGateway('picouncil-igw', {
  vpcId: vpc.id,
  tags: { Name: 'picouncil-igw' },
})

// Public Route Table
const publicRouteTable = new aws.ec2.RouteTable('picouncil-public-rt', {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      gatewayId: igw.id,
    },
  ],
  tags: { Name: 'picouncil-public-rt' },
})

new aws.ec2.RouteTableAssociation('picouncil-public-a-assoc', {
  subnetId: publicSubnetA.id,
  routeTableId: publicRouteTable.id,
})

new aws.ec2.RouteTableAssociation('picouncil-public-b-assoc', {
  subnetId: publicSubnetB.id,
  routeTableId: publicRouteTable.id,
})

// NAT Gateway for private subnets
const eip = new aws.ec2.Eip('picouncil-nat-eip', {
  domain: 'vpc',
  tags: { Name: 'picouncil-nat-eip' },
})

const natGateway = new aws.ec2.NatGateway('picouncil-nat', {
  allocationId: eip.id,
  subnetId: publicSubnetA.id,
  tags: { Name: 'picouncil-nat' },
})

// Private Route Table
const privateRouteTable = new aws.ec2.RouteTable('picouncil-private-rt', {
  vpcId: vpc.id,
  routes: [
    {
      cidrBlock: '0.0.0.0/0',
      natGatewayId: natGateway.id,
    },
  ],
  tags: { Name: 'picouncil-private-rt' },
})

new aws.ec2.RouteTableAssociation('picouncil-private-a-assoc', {
  subnetId: privateSubnetA.id,
  routeTableId: privateRouteTable.id,
})

new aws.ec2.RouteTableAssociation('picouncil-private-b-assoc', {
  subnetId: privateSubnetB.id,
  routeTableId: privateRouteTable.id,
})

// =============================================================================
// Security Groups
// =============================================================================
const albSecurityGroup = new aws.ec2.SecurityGroup('picouncil-alb-sg', {
  vpcId: vpc.id,
  description: 'ALB Security Group',
  ingress: [
    { protocol: 'tcp', fromPort: 80, toPort: 80, cidrBlocks: ['0.0.0.0/0'] },
    { protocol: 'tcp', fromPort: 443, toPort: 443, cidrBlocks: ['0.0.0.0/0'] },
  ],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags: { Name: 'picouncil-alb-sg' },
})

const ecsSecurityGroup = new aws.ec2.SecurityGroup('picouncil-ecs-sg', {
  vpcId: vpc.id,
  description: 'ECS Security Group',
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 8080,
      toPort: 8080,
      securityGroups: [albSecurityGroup.id],
    },
    {
      protocol: 'tcp',
      fromPort: 3000,
      toPort: 3000,
      securityGroups: [albSecurityGroup.id],
    },
  ],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags: { Name: 'picouncil-ecs-sg' },
})

const rdsSecurityGroup = new aws.ec2.SecurityGroup('picouncil-rds-sg', {
  vpcId: vpc.id,
  description: 'RDS Security Group',
  ingress: [
    {
      protocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      securityGroups: [ecsSecurityGroup.id],
    },
  ],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
  tags: { Name: 'picouncil-rds-sg' },
})

// =============================================================================
// RDS PostgreSQL
// =============================================================================
const dbSubnetGroup = new aws.rds.SubnetGroup('picouncil-db-subnet-group', {
  subnetIds: [privateSubnetA.id, privateSubnetB.id],
  tags: { Name: 'picouncil-db-subnet-group' },
})

const dbPassword = config.requireSecret('dbPassword')

const database = new aws.rds.Instance('picouncil-db', {
  identifier: 'picouncil-db',
  engine: 'postgres',
  engineVersion: '16.4',
  instanceClass: 'db.t4g.micro',
  allocatedStorage: 20,
  maxAllocatedStorage: 100,
  storageType: 'gp3',
  dbName: 'picouncil',
  username: 'picouncil',
  password: dbPassword,
  dbSubnetGroupName: dbSubnetGroup.name,
  vpcSecurityGroupIds: [rdsSecurityGroup.id],
  publiclyAccessible: false,
  skipFinalSnapshot: false,
  finalSnapshotIdentifier: 'picouncil-db-final-snapshot',
  backupRetentionPeriod: 7,
  backupWindow: '03:00-04:00',
  maintenanceWindow: 'Mon:04:00-Mon:05:00',
  deletionProtection: true,
  tags: { Name: 'picouncil-db' },
})

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

// Lifecycle policy to cleanup old images
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

// ECR Repository for Admin
const adminEcrRepository = new aws.ecr.Repository('picouncil-admin', {
  name: 'picouncil-admin',
  imageTagMutability: 'MUTABLE',
  imageScanningConfiguration: {
    scanOnPush: true,
  },
  tags: { Name: 'picouncil-admin' },
})

new aws.ecr.LifecyclePolicy('picouncil-admin-lifecycle', {
  repository: adminEcrRepository.name,
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
// ECS Cluster
// =============================================================================
const cluster = new aws.ecs.Cluster('picouncil-cluster', {
  name: 'picouncil-cluster',
  setting: [
    {
      name: 'containerInsights',
      value: 'enabled',
    },
  ],
  tags: { Name: 'picouncil-cluster' },
})

// Task execution role
const taskExecutionRole = new aws.iam.Role('picouncil-task-execution-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Principal: {
          Service: 'ecs-tasks.amazonaws.com',
        },
        Effect: 'Allow',
      },
    ],
  }),
  tags: { Name: 'picouncil-task-execution-role' },
})

new aws.iam.RolePolicyAttachment('picouncil-task-execution-policy', {
  role: taskExecutionRole.name,
  policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
})

// Task role (for application permissions)
const taskRole = new aws.iam.Role('picouncil-task-role', {
  assumeRolePolicy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Action: 'sts:AssumeRole',
        Principal: {
          Service: 'ecs-tasks.amazonaws.com',
        },
        Effect: 'Allow',
      },
    ],
  }),
  tags: { Name: 'picouncil-task-role' },
})

// SSM Parameter Store access for secrets
new aws.iam.RolePolicy('picouncil-task-ssm-policy', {
  role: taskRole.name,
  policy: JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: ['ssm:GetParameters', 'ssm:GetParameter'],
        Resource: `arn:aws:ssm:${AWS_REGION}:*:parameter/picouncil/*`,
      },
    ],
  }),
})

// CloudWatch log group
const logGroup = new aws.cloudwatch.LogGroup('picouncil-logs', {
  name: '/ecs/picouncil-server',
  retentionInDays: 30,
  tags: { Name: 'picouncil-logs' },
})

// Store secrets in SSM Parameter Store
const jwtSecret = config.requireSecret('jwtSecret')

const jwtSecretParam = new aws.ssm.Parameter('picouncil-jwt-secret', {
  name: '/picouncil/jwt-secret',
  type: 'SecureString',
  value: jwtSecret,
  tags: { Name: 'picouncil-jwt-secret' },
})

// Task definition
const taskDefinition = new aws.ecs.TaskDefinition('picouncil-server-task', {
  family: 'picouncil-server',
  cpu: '256',
  memory: '512',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  executionRoleArn: taskExecutionRole.arn,
  taskRoleArn: taskRole.arn,
  containerDefinitions: pulumi.all([database.endpoint, logGroup.name]).apply(([dbEndpoint, logGroupName]) =>
    JSON.stringify([
      {
        name: 'picouncil-server',
        image: serverImage,
        essential: true,
        portMappings: [
          {
            containerPort: 8080,
            protocol: 'tcp',
          },
        ],
        environment: [
          { name: 'PORT', value: '8080' },
          { name: 'ENVIRONMENT', value: 'production' },
          { name: 'DATABASE_URL', value: `postgres://picouncil:${dbPassword}@${dbEndpoint}/picouncil?sslmode=require` },
          { name: 'FRONTEND_URL', value: `https://${DOMAIN}` },
        ],
        secrets: [
          {
            name: 'JWT_SECRET',
            valueFrom: jwtSecretParam.arn,
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
          command: ['CMD-SHELL', 'wget -q --spider http://localhost:8080/health || exit 1'],
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
// Application Load Balancer
// =============================================================================
const alb = new aws.lb.LoadBalancer('picouncil-alb', {
  name: 'picouncil-alb',
  internal: false,
  loadBalancerType: 'application',
  securityGroups: [albSecurityGroup.id],
  subnets: [publicSubnetA.id, publicSubnetB.id],
  tags: { Name: 'picouncil-alb' },
})

const targetGroup = new aws.lb.TargetGroup('picouncil-tg', {
  name: 'picouncil-tg',
  port: 8080,
  protocol: 'HTTP',
  targetType: 'ip',
  vpcId: vpc.id,
  healthCheck: {
    path: '/health',
    healthyThreshold: 2,
    unhealthyThreshold: 3,
    timeout: 5,
    interval: 30,
  },
  tags: { Name: 'picouncil-tg' },
})

// HTTP listener (redirect to HTTPS)
new aws.lb.Listener('picouncil-http-listener', {
  loadBalancerArn: alb.arn,
  port: 80,
  protocol: 'HTTP',
  defaultActions: [
    {
      type: 'redirect',
      redirect: {
        port: '443',
        protocol: 'HTTPS',
        statusCode: 'HTTP_301',
      },
    },
  ],
})

// Certificate (create in AWS Certificate Manager first)
// For now, use HTTP only in development
const httpsListener = new aws.lb.Listener('picouncil-https-listener', {
  loadBalancerArn: alb.arn,
  port: 443,
  protocol: 'HTTPS',
  sslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06',
  certificateArn: config.get('certificateArn') || '', // Set via: pulumi config set certificateArn <ARN>
  defaultActions: [
    {
      type: 'forward',
      targetGroupArn: targetGroup.arn,
    },
  ],
})

// =============================================================================
// ECS Service
// =============================================================================
const service = new aws.ecs.Service('picouncil-server-service', {
  name: 'picouncil-server',
  cluster: cluster.arn,
  taskDefinition: taskDefinition.arn,
  desiredCount: 1,
  launchType: 'FARGATE',
  networkConfiguration: {
    subnets: [privateSubnetA.id, privateSubnetB.id],
    securityGroups: [ecsSecurityGroup.id],
    assignPublicIp: false,
  },
  loadBalancers: [
    {
      targetGroupArn: targetGroup.arn,
      containerName: 'picouncil-server',
      containerPort: 8080,
    },
  ],
  healthCheckGracePeriodSeconds: 60,
  tags: { Name: 'picouncil-server-service' },
})

// =============================================================================
// Admin Dashboard (ECS Service)
// =============================================================================
const adminLogGroup = new aws.cloudwatch.LogGroup('picouncil-admin-logs', {
  name: '/ecs/picouncil-admin',
  retentionInDays: 30,
  tags: { Name: 'picouncil-admin-logs' },
})

const adminTaskDefinition = new aws.ecs.TaskDefinition('picouncil-admin-task', {
  family: 'picouncil-admin',
  cpu: '256',
  memory: '512',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  executionRoleArn: taskExecutionRole.arn,
  taskRoleArn: taskRole.arn,
  containerDefinitions: adminLogGroup.name.apply((logGroupName) =>
    JSON.stringify([
      {
        name: 'picouncil-admin',
        image: adminImage,
        essential: true,
        portMappings: [
          {
            containerPort: 3000,
            protocol: 'tcp',
          },
        ],
        environment: [
          { name: 'NODE_ENV', value: 'production' },
          { name: 'NEXT_PUBLIC_API_URL', value: `https://api.${DOMAIN}` },
          { name: 'NEXT_PUBLIC_SITE_URL', value: `https://admin.${DOMAIN}` },
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
          command: ['CMD-SHELL', 'wget -q --spider http://localhost:3000 || exit 1'],
          interval: 30,
          timeout: 5,
          retries: 3,
          startPeriod: 60,
        },
      },
    ])
  ),
  tags: { Name: 'picouncil-admin-task' },
})

const adminTargetGroup = new aws.lb.TargetGroup('picouncil-admin-tg', {
  name: 'picouncil-admin-tg',
  port: 3000,
  protocol: 'HTTP',
  targetType: 'ip',
  vpcId: vpc.id,
  healthCheck: {
    path: '/',
    healthyThreshold: 2,
    unhealthyThreshold: 3,
    timeout: 5,
    interval: 30,
  },
  tags: { Name: 'picouncil-admin-tg' },
})

// HTTPS listener rule for admin subdomain
new aws.lb.ListenerRule('picouncil-admin-rule', {
  listenerArn: httpsListener.arn,
  priority: 10,
  conditions: [
    {
      hostHeader: {
        values: [`admin.${DOMAIN}`],
      },
    },
  ],
  actions: [
    {
      type: 'forward',
      targetGroupArn: adminTargetGroup.arn,
    },
  ],
})

const adminService = new aws.ecs.Service('picouncil-admin-service', {
  name: 'picouncil-admin',
  cluster: cluster.arn,
  taskDefinition: adminTaskDefinition.arn,
  desiredCount: 1,
  launchType: 'FARGATE',
  networkConfiguration: {
    subnets: [privateSubnetA.id, privateSubnetB.id],
    securityGroups: [ecsSecurityGroup.id],
    assignPublicIp: false,
  },
  loadBalancers: [
    {
      targetGroupArn: adminTargetGroup.arn,
      containerName: 'picouncil-admin',
      containerPort: 3000,
    },
  ],
  healthCheckGracePeriodSeconds: 60,
  tags: { Name: 'picouncil-admin-service' },
})

// =============================================================================
// S3 Bucket (File Storage)
// =============================================================================
const filesBucket = new aws.s3.BucketV2('picouncil-files', {
  bucket: 'picouncil-files',
  tags: { Name: 'picouncil-files' },
})

new aws.s3.BucketVersioningV2('picouncil-files-versioning', {
  bucket: filesBucket.id,
  versioningConfiguration: {
    status: 'Enabled',
  },
})

new aws.s3.BucketServerSideEncryptionConfigurationV2('picouncil-files-encryption', {
  bucket: filesBucket.id,
  rules: [
    {
      applyServerSideEncryptionByDefault: {
        sseAlgorithm: 'AES256',
      },
    },
  ],
})

// Block public access
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
export const albDnsName = alb.dnsName
export const ecrServerUrl = ecrRepository.repositoryUrl
export const ecrAdminUrl = adminEcrRepository.repositoryUrl
export const databaseEndpoint = database.endpoint
export const filesBucketName = filesBucket.id
export const clusterArn = cluster.arn
