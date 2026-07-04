"use client"

import { motion } from "framer-motion"

const nodes = [
  { id: "source", label: "Source", x: 0, y: 0 },
  { id: "build", label: "Build", x: 1, y: -1 },
  { id: "test", label: "Test", x: 1, y: 1 },
  { id: "stage", label: "Staging", x: 2, y: 0 },
  { id: "canary", label: "Canary", x: 3, y: -1 },
  { id: "prod", label: "Production", x: 3, y: 1 },
]

const edges = [
  { from: "source", to: "build", progress: 1 },
  { from: "source", to: "test", progress: 1 },
  { from: "build", to: "stage", progress: 0.7 },
  { from: "test", to: "stage", progress: 0.7 },
  { from: "stage", to: "canary", progress: 0.4 },
  { from: "stage", to: "prod", progress: 0.2 },
]

const nodeVariants = {
  hidden: { scale: 0, opacity: 0 },
  visible: (i: number) => ({
    scale: 1,
    opacity: 1,
    transition: { delay: 0.4 + i * 0.08, duration: 0.35, ease: [0.25, 1, 0.5, 1] as const },
  }),
}

const edgeVariants = {
  hidden: { pathLength: 0, opacity: 0 },
  visible: (i: number) => ({
    pathLength: 1,
    opacity: 1,
    transition: { delay: 0.6 + i * 0.1, duration: 0.6, ease: [0.25, 1, 0.5, 1] as const },
  }),
}

function getNodePos(id: string) {
  const n = nodes.find((x) => x.id === id)!
  return {
    x: 80 + n.x * 180,
    y: 60 + n.y * 70,
  }
}

export function PipelineVisualization() {
  const margin = 20
  const w = 80 + 3 * 180 + margin * 2
  const h = 60 + 70 + margin * 2

  return (
    <div className="relative overflow-hidden rounded-xl bg-gradient-to-b from-primary/[0.04] to-transparent">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        className="w-full h-auto"
        style={{ maxHeight: 200 }}
        aria-label="Pipeline flow visualization"
      >
        {/* Grid dots */}
        <pattern id="dots" x="0" y="0" width="20" height="20" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" fill="currentColor" className="text-border/30" />
        </pattern>
        <rect width="100%" height="100%" fill="url(#dots)" />

        {/* Edges */}
        {edges.map((edge, i) => {
          const from = getNodePos(edge.from)
          const to = getNodePos(edge.to)
          const mx = (from.x + to.x) / 2
          const my = (from.y + to.y) / 2 - 12
          return (
            <g key={edge.from + edge.to}>
              <motion.path
                d={`M${from.x} ${from.y} Q${mx} ${my} ${to.x} ${to.y}`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                className="text-border/50"
                variants={edgeVariants}
                custom={i}
                initial="hidden"
                whileInView="visible"
                viewport={{ once: true }}
              />
              <motion.circle
                cx={from.x + (to.x - from.x) * edge.progress}
                cy={from.y + (to.y - from.y) * edge.progress - 12 * Math.sin(Math.PI * edge.progress)}
                r={2.5}
                fill="currentColor"
                className="text-primary"
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.8 + i * 0.12 }}
              />
            </g>
          )
        })}

        {/* Nodes */}
        {nodes.map((node, i) => (
          <motion.g
            key={node.id}
            variants={nodeVariants}
            custom={i}
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true }}
          >
            <rect
              x={node.x - 30}
              y={node.y - 11}
              width={60}
              height={22}
              rx={6}
              className="fill-card stroke-border/60"
              strokeWidth={1}
            />
            <text
              x={node.x}
              y={node.y + 4}
              textAnchor="middle"
              className="fill-foreground text-[10px] font-medium"
            >
              {node.label}
            </text>
          </motion.g>
        ))}
      </svg>
    </div>
  )
}
