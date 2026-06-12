"use client"

import { motion } from "framer-motion"

const nodes = [
  { x: 60, y: 90, label: "Source", color: "hsl(35, 90%, 55%)", icon: "📦" },
  { x: 200, y: 90, label: "Build", color: "hsl(200, 80%, 55%)", icon: "🔧" },
  { x: 340, y: 90, label: "Stage", color: "hsl(160, 70%, 45%)", icon: "🌍" },
  { x: 480, y: 90, label: "Canary", color: "hsl(280, 70%, 60%)", icon: "🎯" },
  { x: 620, y: 90, label: "Release", color: "hsl(0, 70%, 55%)", icon: "🚀" },
  { x: 760, y: 90, label: "Healthy", color: "hsl(145, 70%, 45%)", icon: "✅" },
]

const connections = [
  { from: 60, to: 200 },
  { from: 200, to: 340 },
  { from: 340, to: 480 },
  { from: 480, to: 620 },
  { from: 620, to: 760 },
]

const gatewayIcon = (x: number) => (
  <g>
    <rect
      x={x - 80}
      y={55}
      width={160}
      height={24}
      rx={4}
      fill="hsl(200, 80%, 55%)"
      fillOpacity={0.15}
      stroke="hsl(200, 80%, 55%)"
      strokeWidth={1}
      strokeDasharray="4 2"
    />
    <text
      x={x}
      y={71}
      textAnchor="middle"
      fill="hsl(200, 80%, 55%)"
      fontSize={10}
      fontWeight={500}
    >
      Gateway API / Istio
    </text>
  </g>
)

export function PipelineVisualization() {
  return (
    <div className="relative">
      <svg
        viewBox="0 0 840 180"
        className="h-auto w-full"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="7"
            refX="9"
            refY="3.5"
            orient="auto"
          >
            <polygon
              points="0 0, 10 3.5, 0 7"
              fill="hsl(200, 15%, 60%)"
            />
          </marker>
        </defs>

        {/* Background glow */}
        <ellipse
          cx={420}
          cy={100}
          rx={380}
          ry={60}
          fill="hsl(200, 80%, 55%)"
          opacity={0.03}
        />

        {/* Gateway layer */}
        {gatewayIcon(270)}

        {/* Connections with animated arrows */}
        {connections.map((conn, i) => (
          <motion.g key={`conn-${i}`}>
            <line
              x1={conn.from + 50}
              y1={90}
              x2={conn.to - 50}
              y2={90}
              stroke="hsl(200, 15%, 60%)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              markerEnd="url(#arrowhead)"
            />
            {/* Animated dot */}
            <motion.circle
              r={3}
              fill="hsl(200, 80%, 55%)"
              initial={{ cx: conn.from + 50, cy: 90 }}
              animate={{
                cx: [conn.from + 50, conn.to - 50, conn.from + 50],
                cy: 90,
              }}
              transition={{
                duration: 2.5 + i * 0.3,
                repeat: Infinity,
                ease: "linear" as const,
              }}
            />
          </motion.g>
        ))}

        {/* Nodes */}
        {nodes.map((node, i) => (
          <motion.g
            key={node.label}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.12, duration: 0.5 }}
          >
            {/* Node background */}
            <rect
              x={node.x - 40}
              y={node.y - 24}
              width={80}
              height={48}
              rx={10}
              fill="hsl(220, 15%, 12%)"
              stroke={node.color}
              strokeWidth={1.5}
              filter={i === 4 ? "url(#glow)" : undefined}
            />
            <rect
              x={node.x - 38}
              y={node.y - 22}
              width={76}
              height={44}
              rx={8}
              fill={node.color}
              opacity={0.08}
            />

            {/* Icon */}
            <text
              x={node.x}
              y={node.y - 2}
              textAnchor="middle"
              fontSize={16}
            >
              {node.icon}
            </text>

            {/* Label */}
            <text
              x={node.x}
              y={node.y + 22}
              textAnchor="middle"
              fill="hsl(220, 15%, 85%)"
              fontSize={11}
              fontWeight={600}
              letterSpacing={0.5}
            >
              {node.label}
            </text>
          </motion.g>
        ))}

        {/* Background grid pattern */}
        <pattern
          id="grid"
          width={40}
          height={40}
          patternUnits="userSpaceOnUse"
        >
          <path
            d="M 40 0 L 0 0 0 40"
            fill="none"
            stroke="hsl(220, 15%, 20%)"
            strokeWidth={0.5}
          />
        </pattern>
        <rect width={840} height={180} fill="url(#grid)" opacity={0.3} />
      </svg>

      {/* Kubernetes pod decorations */}
      <div className="absolute -left-2 top-1/3">
        <KubePod delay={0} />
      </div>
      <div className="absolute -right-2 top-1/4">
        <KubePod delay={1.5} />
      </div>
    </div>
  )
}

function KubePod({ delay }: { delay: number }) {
  return (
    <motion.div
      className="flex size-6 items-center justify-center rounded border border-border/30 bg-muted/50 text-[10px]"
      initial={{ opacity: 0 }}
      animate={{ opacity: [0.3, 0.7, 0.3] }}
      transition={{
        duration: 3,
        repeat: Infinity,
        delay,
        ease: "easeInOut" as const,
      }}
    >
      ⊞
    </motion.div>
  )
}
